import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GgufImportPolicy } from '../../../../shared/gguf-import-policy.cjs';
import { modelRuntimeUrl } from '../ollama-client';

const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
type RuntimeResponse = { response: Response; close: () => void };
/** Pinned Ollama 0.35.1 API: no pull/from/template, only explicit local blob and files creation. */
export class GgufOllamaTransport {
    constructor(
        private readonly request: typeof fetch = globalThis.fetch,
        private readonly env: NodeJS.ProcessEnv = process.env,
    ) {}
    private async call(
        route: string,
        options: RequestInit,
        limits: GgufImportPolicy,
        signal: AbortSignal,
        timeoutMs = limits.runtimeRequestTimeoutMs,
    ) {
        signal.throwIfAborted();
        if (this.env.MODEL_HOSTING_ENABLED === 'false')
            throw new ServiceUnavailableException(
                'Хостинг моделей выключен. Настройте локальный Ollama через управление площадкой.',
            );
        const controller = new AbortController(),
            abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref();
        const close = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        };
        try {
            return {
                response: await this.request(modelRuntimeUrl(this.env) + route, {
                    ...options,
                    redirect: 'error',
                    signal: controller.signal,
                }),
                close,
            };
        } catch {
            close();
            if (signal.aborted) throw signal.reason;
            throw new ServiceUnavailableException(
                'Локальный Ollama не ответил. Проверьте настройку runtime; автоматическая загрузка не выполнялась.',
            );
        }
    }
    private async json(owned: RuntimeResponse, limits: GgufImportPolicy): Promise<Record<string, unknown>> {
        const { response } = owned;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            if (!response.ok) {
                await response.body?.cancel();
                throw new ConflictException(
                    'Ollama отклонил операцию. Проверьте совместимость GGUF и настройку runtime.',
                );
            }
            reader = response.body?.getReader();
            if (!reader) throw new ConflictException('Ollama вернул пустой ответ.');
            let bytes = 0;
            const chunks: Uint8Array[] = [];
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                bytes += next.value.length;
                if (bytes > limits.runtimeResponseBytes)
                    throw new ConflictException('Ответ Ollama превышает настроенный лимит.');
                chunks.push(next.value);
            }
            const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!object(data)) throw Error('response');
            return data;
        } catch (error) {
            await reader?.cancel().catch(() => {});
            if (error instanceof ConflictException) throw error;
            throw new ConflictException('Ollama вернул некорректный или незавершённый ответ.');
        } finally {
            reader?.releaseLock();
            owned.close();
        }
    }
    async version(limits: GgufImportPolicy, signal: AbortSignal) {
        const version = await this.json(await this.call('/api/version', { method: 'GET' }, limits, signal), limits);
        if (version.version !== '0.35.1')
            throw new ConflictException(
                'Для импорта GGUF настройте управляемый Ollama версии 0.35.1. Автоустановка не выполнялась.',
            );
    }
    async tag(alias: string, limits: GgufImportPolicy, signal: AbortSignal): Promise<string | null> {
        const tags = await this.json(await this.call('/api/tags', { method: 'GET' }, limits, signal), limits);
        if (!Array.isArray(tags.models)) throw new ConflictException('Ollama не подтвердил список моделей.');
        const found = tags.models.find((item) => object(item) && (item.name === alias || item.model === alias));
        if (!found) return null;
        if (
            !object(found) ||
            typeof found.digest !== 'string' ||
            (!/^sha256:[a-f0-9]{64}$/.test(found.digest) && !/^[a-f0-9]{64}$/.test(found.digest))
        )
            throw new ConflictException('Ollama не подтвердил digest модели.');
        return found.digest.replace(/^sha256:/, '');
    }
    async blobExists(sha256: string, limits: GgufImportPolicy, signal: AbortSignal) {
        const owned = await this.call('/api/blobs/sha256:' + sha256, { method: 'HEAD' }, limits, signal);
        try {
            await owned.response.body?.cancel();
            if (owned.response.status === 200) return true;
            if (owned.response.status === 404) return false;
            throw new ConflictException('Ollama не подтвердил состояние blob.');
        } finally {
            owned.close();
        }
    }
    async upload(
        filename: string,
        bytes: number,
        sha256: string,
        limits: GgufImportPolicy,
        signal: AbortSignal,
        check: () => Promise<void>,
    ) {
        const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
            controller = new AbortController(),
            abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let transfer: Promise<void> | undefined, input: Readable | undefined, body: Transform | undefined;
        const deadline = setTimeout(() => controller.abort(), limits.uploadTimeoutMs);
        deadline.unref();
        try {
            const before = await file.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size !== bytes || (before.mode & 0o222) !== 0)
                throw new ConflictException('Проверенный GGUF изменён.');
            let received = 0,
                lastCheck = 0;
            const hash = createHash('sha256');
            body = new Transform({
                transform(chunk: Buffer, _encoding, done) {
                    received += chunk.length;
                    if (received > bytes) {
                        done(new ConflictException('GGUF изменился во время передачи runtime.'));
                        return;
                    }
                    hash.update(chunk);
                    if (Date.now() - lastCheck >= limits.checkIntervalMs) {
                        lastCheck = Date.now();
                        void check().then(() => done(null, chunk), done);
                    } else done(null, chunk);
                },
                final(done) {
                    if (received !== bytes || hash.digest('hex') !== sha256) {
                        done(new ConflictException('SHA-256 GGUF изменился во время передачи runtime.'));
                        return;
                    }
                    done();
                },
            });
            input = file.createReadStream({ autoClose: false });
            transfer = pipeline(input, body, { signal: controller.signal });
            void transfer.catch(() => controller.abort());
            const owned = await this.call(
                '/api/blobs/sha256:' + sha256,
                {
                    method: 'POST',
                    body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
                    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes) },
                    duplex: 'half',
                } as RequestInit & { duplex: 'half' },
                limits,
                controller.signal,
                limits.uploadTimeoutMs,
            );
            try {
                if (owned.response.status !== 201) {
                    await owned.response.body?.cancel();
                    throw new ConflictException('Ollama не подтвердил SHA-256 загруженного blob.');
                }
                await owned.response.body?.cancel();
                await transfer;
                await check();
            } finally {
                owned.close();
            }
            const after = await file.stat();
            if (
                before.ino !== after.ino ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                after.nlink !== 1
            )
                throw new ConflictException('Исходный GGUF изменился.');
        } finally {
            clearTimeout(deadline);
            signal.removeEventListener('abort', abort);
            controller.abort();
            input?.destroy();
            body?.destroy();
            await transfer?.catch(() => {});
            await file.close();
        }
    }
    async create(alias: string, sha256: string, limits: GgufImportPolicy, signal: AbortSignal) {
        const result = await this.json(
            await this.call(
                '/api/create',
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ model: alias, files: { 'model.gguf': 'sha256:' + sha256 }, stream: false }),
                },
                limits,
                signal,
                limits.uploadTimeoutMs,
            ),
            limits,
        );
        if (result.status !== 'success')
            throw new ConflictException('Ollama не подтвердил создание модели. Проверьте сохранённую операцию.');
    }
}
