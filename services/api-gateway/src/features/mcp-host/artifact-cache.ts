import axios from 'axios';
import { execFile } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HostedMcpClaim } from './ticket';

const pExecFile = promisify(execFile);

const cacheRoot = (): string => path.resolve(process.env.NEUROCENTER_MCP_HOST_DIR || path.join(os.tmpdir(), 'neurocenter-mcp-host'));
const inflight = new Map<string, Promise<string>>();

/** Одна развёртка на SHA-256: скачивание с каталога по внутреннему токену, TAR без чужих флагов, копия только своих файлов. */
export async function materializeArtifact(claim: HostedMcpClaim, catalogUrl: string, internalToken: string): Promise<string> {
    const finalRoot = path.join(cacheRoot(), 'artifacts', claim.artifactSha256);
    if (await ready(finalRoot, claim.entrypoint)) { return finalRoot; }
    const pending = inflight.get(claim.artifactSha256);
    if (pending) { return pending; }
    const task = build(claim, finalRoot, catalogUrl, internalToken).finally(() => inflight.delete(claim.artifactSha256));
    inflight.set(claim.artifactSha256, task);
    return task;
}

async function build(claim: HostedMcpClaim, finalRoot: string, catalogUrl: string, internalToken: string): Promise<string> {
    const stage = path.join(cacheRoot(), 'building', `.build-${claim.artifactSha256.slice(0, 12)}-${randomUUID()}`);
    const archive = path.join(stage, 'artifact.tar.gz');
    const unpack = path.join(stage, 'unpack');
    try {
        await fs.lstat(finalRoot).then(info => { if (info.isDirectory()) return fs.rm(finalRoot, { recursive: true, force: true }); }, () => undefined);
        await fs.mkdir(path.dirname(finalRoot), { recursive: true });
        await fs.mkdir(stage, { recursive: true, mode: 0o700 });
        await fs.mkdir(unpack, { recursive: true, mode: 0o700 });
        const response = await axios.get(`${catalogUrl.replace(/\/+$/, '')}/internal/mcp-host/artifact/${claim.artifactSha256}`, {
            responseType: 'stream', timeout: 120000, maxContentLength: claim.compressedBytes, maxBodyLength: claim.compressedBytes,
            headers: { 'x-neurocenter-internal': internalToken, 'accept-encoding': 'gzip' },
        });
        if (response.status !== 200) { throw new Error('Комплект хоста недоступен в каталоге.'); }
        let bytes = 0;
        const sink = createWriteStream(archive, { mode: 0o600 });
        const drained = new Promise<void>((resolve, reject) => { sink.once('finish', () => resolve()); sink.once('error', reject); });
        try {
            for await (const chunk of response.data) {
                bytes += (chunk as Buffer).length;
                if (bytes > claim.compressedBytes) { throw new Error('Комплект хоста больше одобренной описи.'); }
                if (!sink.write(chunk as Buffer)) { await new Promise<void>(resolve => sink.once('drain', resolve)); }
            }
        } finally { sink.end(); }
        await drained;
        if (bytes !== claim.compressedBytes) { throw new Error('Размер комплекта хоста не совпадает с описью.'); }
        await pExecFile('/usr/bin/tar', ['-xzf', archive, '-C', unpack, '--no-same-owner', '--no-same-permissions', '-p'], { timeout: 120000 });
        const entry = await fs.lstat(path.join(unpack, claim.entrypoint)).catch(() => null);
        if (!entry || !entry.isFile()) { throw new Error('Точка входа отсутствует в развёрнутом комплекте.'); }
        await fs.cp(unpack, finalRoot, {
            recursive: true, force: false, errorOnExist: true,
            filter: async source => {
                const relative = path.relative(unpack, source);
                if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { return false; }
                const info = await fs.lstat(source).catch(() => null);
                return !!info && !info.isSymbolicLink();
            },
        });
        const handle = await fs.open(path.join(finalRoot, '.ready'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, sha256: claim.artifactSha256, publishedAt: new Date().toISOString() })); }
        finally { await handle.close(); }
        return finalRoot;
    } catch (error) {
        await fs.rm(stage, { recursive: true, force: true });
        throw new Error('Комплект хоста недоступен. Повторите подключение.');
    }
}

async function ready(root: string, entrypoint: string): Promise<boolean> {
    try {
        const marker = await fs.stat(path.join(root, '.ready'));
        const entry = await fs.lstat(path.join(root, entrypoint));
        return marker.isFile() && entry.isFile();
    } catch { return false; }
}
