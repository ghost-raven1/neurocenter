import { GatewayTimeoutException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readDevBridgeRuntime } from './dev-bridge-runtime';
import type { IBridgeArtifact, IBridgeSupply } from './bridge-supply.types';
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const TARGET = /^(darwin|linux|windows)-(x64|arm64)(-musl)?$/;

/** Gateway раздаёт imported supply; явный development override выбирает только локальную host-сборку. */
@Injectable()
export class BridgeSupplyService {
    private readonly catalogUrl: string;
    private readonly http: AxiosInstance;
    private readonly devRuntimeDirectory?: string;

    constructor(config: ConfigService) {
        this.catalogUrl = (config.get<string>('CATALOG_SERVICE_URL') || 'http://localhost:4100').replace(/\/+$/, '');
        this.http = axios.create({ timeout: 15000, maxRedirects: 0, maxContentLength: 128 * 1024, validateStatus: () => true });
        if ((config.get<string>('NODE_ENV') || process.env.NODE_ENV) === 'development') {
            this.devRuntimeDirectory = config.get<string>('DEV_BRIDGE_RUNTIME_DIR') || undefined;
        }
    }

    /** Проверенная локальная dev-поставка доступна без каталога; открытый архив всегда закрывается здесь. */
    public async developmentSupply(signal: AbortSignal): Promise<IBridgeSupply | undefined> {
        const local = this.devRuntimeDirectory ? await readDevBridgeRuntime(this.devRuntimeDirectory, signal) : undefined;
        if (local) {
            try { return local.supply; } finally { await local.archive.close(); }
        }
        return undefined;
    }

    /** Историческая версия выбирается явно, чтобы обновление head не обрывало уже начатую установку. */
    public async supply(signal: AbortSignal, version?: string): Promise<IBridgeSupply> {
        if (version !== undefined && !VERSION.test(version)) { throw new NotFoundException('Версия моста не найдена.'); }
        const local = await this.developmentSupply(signal);
        if (local) {
            if (version !== undefined && version !== local.version) { throw new NotFoundException('Dev-версия моста не найдена.'); }
            return local;
        }
        return this.importedSupply(signal, version);
    }

    private async importedSupply(signal: AbortSignal, version?: string): Promise<IBridgeSupply> {
        let result;
        try {
            result = await this.http.get(`${this.catalogUrl}/internal/asset-sources/bridge`, {
                signal, params: version ? { version } : undefined, headers: this.headers(),
            });
        } catch {
            throw new ServiceUnavailableException('Источник моста недоступен. Повторите установку позже.');
        }
        if (result.status === 404) {
            throw new NotFoundException({ code: 'BRIDGE_NOT_IMPORTED', message: 'Мост ещё не добавлен из репозитория ассетов. Обратитесь к главному администратору.' });
        }
        if (result.status !== 200 || !validSupply(result.data, version)) {
            throw new ServiceUnavailableException('Не удалось проверить импортированную поставку моста.');
        }
        return result.data;
    }

    /** Метаданные и checksum берутся из того же неизменяемого descriptor, что и архив. */
    public async runtime(file: string, signal: AbortSignal, res: Response, download = false): Promise<void> {
        const match = /^neurocenter-asset-sync-((?:darwin|linux|windows)-(?:x64|arm64)(?:-musl)?)-(\d+\.\d+\.\d+)\.tgz(\.sha256|\.json)?$/.exec(file);
        if (!match) { throw new NotFoundException('Пакет для этой платформы не найден.'); }
        const local = this.devRuntimeDirectory ? await readDevBridgeRuntime(this.devRuntimeDirectory, signal) : undefined;
        if (local) {
            try {
                if (local.artifact.file !== file.replace(/\.(?:sha256|json)$/, '') || local.artifact.target !== match[1]) { throw new NotFoundException('Dev-пакет для этой платформы не собран.'); }
                if (signal.aborted) { return; }
                res.setHeader('cache-control', 'no-store');
                if (download) { res.setHeader('content-disposition', `attachment; filename="${file}"`); }
                if (match[3]) {
                    res.setHeader('content-type', match[3] === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
                    res.send(match[3] === '.json' ? JSON.stringify(local.artifact.metadata) + '\n' : local.artifact.sha256 + '\n');
                } else {
                    try { await this.transfer(local.archive.createReadStream({ start: 0, autoClose: false, signal }), local.artifact, signal, res); }
                    catch {
                        if (signal.aborted || res.destroyed) { return; }
                        if (res.headersSent) { res.destroy(); return; }
                        res.removeHeader('content-length'); res.removeHeader('content-type'); res.removeHeader('content-disposition');
                        throw new ServiceUnavailableException('Передача dev-пакета моста прервана. Повторите установку.');
                    }
                }
            } finally { await local.archive.close(); }
            return;
        }
        const supply = await this.importedSupply(signal, match[2]);
        if (signal.aborted) { return; }
        const artifact = supply.artifacts.find(item => item.file === file.replace(/\.(?:sha256|json)$/, '') && item.target === match[1]);
        if (!artifact) { throw new NotFoundException('Пакет для этой платформы ещё не импортирован.'); }
        res.setHeader('cache-control', 'no-store');
        if (download) { res.setHeader('content-disposition', `attachment; filename="${file}"`); }
        if (match[3]) {
            res.setHeader('content-type', match[3] === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
            res.send(match[3] === '.json' ? JSON.stringify(artifact.metadata) + '\n' : artifact.sha256 + '\n');
            return;
        }
        await this.stream(artifact, signal, res);
    }

    private headers(): Record<string, string> { return { 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '' }; }

    private async stream(artifact: IBridgeArtifact, signal: AbortSignal, res: Response): Promise<void> {
        let upstream;
        try {
            upstream = await this.http.get(`${this.catalogUrl}/internal/asset-sources/blobs/${artifact.sha256}`, {
                responseType: 'stream', timeout: 600000, maxContentLength: artifact.bytes, signal, headers: this.headers(),
            });
            if (signal.aborted) { upstream.data.destroy(); return; }
            if (upstream.status !== 200 || String(upstream.headers['content-length']) !== String(artifact.bytes)
                || upstream.headers.etag !== '"' + artifact.sha256 + '"') {
                upstream.data.destroy();
                throw new Error('Импортированные байты недоступны.');
            }
            await this.transfer(upstream.data, artifact, signal, res);
        } catch {
            upstream?.data.destroy();
            if (signal.aborted || res.destroyed) { return; }
            if (res.headersSent) { res.destroy(); return; }
            res.removeHeader('content-length');
            res.removeHeader('content-type');
            res.removeHeader('content-disposition');
            throw new ServiceUnavailableException('Передача пакета моста прервана. Повторите установку.');
        }
    }

    private async transfer(input: NodeJS.ReadableStream, artifact: IBridgeArtifact, signal: AbortSignal, res: Response): Promise<void> {
        let received = 0;
        const hash = createHash('sha256');
        res.setHeader('content-type', 'application/gzip');
        res.setHeader('content-length', String(artifact.bytes));
        await pipeline(input, new Transform({
            transform(chunk: Buffer, _encoding, done) {
                received += chunk.length;
                if (received > artifact.bytes) { done(new Error('Размер архива изменился.')); return; }
                hash.update(chunk); done(null, chunk);
            },
            flush(done) { done(received === artifact.bytes && hash.digest('hex') === artifact.sha256 ? undefined : new Error('Архив не совпал с импортированной версией.')); },
        }), res, { signal });
    }
}

/** В ответе supply отсутствуют внешние адреса; произвольный URL не может стать маршрутом скачивания. */
function validSupply(value: unknown, requested?: string): value is IBridgeSupply {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const data = value as IBridgeSupply;
    if (Object.keys(data).some(key => !['assetId', 'version', 'buildId', 'sourceCommit', 'artifacts'].includes(key))
        || typeof data.assetId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(data.assetId)
        || typeof data.version !== 'string' || !VERSION.test(data.version) || requested !== undefined && data.version !== requested
        || typeof data.buildId !== 'string' || !SHA.test(data.buildId) || typeof data.sourceCommit !== 'string' || !/^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(data.sourceCommit)
        || !Array.isArray(data.artifacts) || !data.artifacts.length || data.artifacts.length > 8) { return false; }
    const targets = new Set<string>();
    return data.artifacts.every(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['file', 'target', 'sha256', 'bytes', 'metadata'].includes(key))
            || typeof item.target !== 'string' || !TARGET.test(item.target) || item.target.startsWith('windows-') && item.target.endsWith('-musl')
            || item.target.startsWith('darwin-') && item.target.endsWith('-musl') || targets.has(item.target)
            || item.file !== `neurocenter-asset-sync-${item.target}-${data.version}.tgz`
            || typeof item.sha256 !== 'string' || !SHA.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 1024 ** 3
            || !item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata)) { return false; }
        const metadata = item.metadata;
        if (Object.keys(metadata).some(key => !['version', 'target', 'nodeVersion', 'buildId', 'ragSupported', 'probeEngine', 'windowsJobHelper', 'sha256', 'bytes'].includes(key))
            || metadata.version !== data.version || metadata.buildId !== data.buildId || metadata.target !== item.target || metadata.sha256 !== item.sha256 || metadata.bytes !== item.bytes) { return false; }
        targets.add(item.target); return true;
    });
}

/** Одна загрузка имеет свой deadline; отключение клиента не отменяет соседнюю установку. */
export async function bridgeRequest(req: Request, res: Response, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    let timedOut = false;
    const abort = new AbortController(), closed = () => { if (!res.writableEnded) { abort.abort(); } }, disconnected = () => abort.abort();
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 600000);
    req.on('aborted', disconnected); res.on('close', closed);
    try {
        if (req.aborted || res.destroyed) { abort.abort(); }
        if (!abort.signal.aborted) { await operation(abort.signal); }
        if (timedOut && !res.destroyed && !res.writableEnded) { throw new GatewayTimeoutException('Пакет моста не удалось передать вовремя. Повторите установку.'); }
    } catch (error) {
        if (!abort.signal.aborted) { throw error; }
        if (timedOut && !res.destroyed && !res.writableEnded) { throw new GatewayTimeoutException('Пакет моста не удалось передать вовремя. Повторите установку.'); }
    }
    finally { clearTimeout(timer); req.off('aborted', disconnected); res.off('close', closed); }
}
