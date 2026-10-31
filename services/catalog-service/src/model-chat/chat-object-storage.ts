import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Client } from 'minio';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { assertPrivateS3Bucket } from '../../../shared/s3-bucket-privacy.cjs';

export interface ChatS3Configuration {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    projectBucket: string;
    personalBucket: string;
}
export interface ChatObjectReference {
    storage_id: string;
    bucket: string;
    object_key: string;
    version_id: string | null;
    sha256: string;
    bytes: number;
}
export const chatObjectDigest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const unavailable = (): ServiceUnavailableException =>
    new ServiceUnavailableException('Хранилище файлов чата недоступно. Проверьте подключение Ceph/S3 и повторите.');
const code = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

/** Endpoint and credentials are operator settings; neither is returned in chat metadata. */
export function chatS3Configuration(env: NodeJS.ProcessEnv = process.env): ChatS3Configuration | null {
    const names = [
        'CHAT_S3_ENDPOINT',
        'CHAT_S3_ACCESS_KEY',
        'CHAT_S3_SECRET_KEY',
        'CHAT_S3_PROJECT_BUCKET',
        'CHAT_S3_PERSONAL_BUCKET',
    ] as const;
    if (names.every((name) => !env[name])) return null;
    if (names.some((name) => !env[name])) throw new Error('Заполните адрес, ключи и оба закрытых бакета CHAT_S3_*.');
    return {
        endpoint: env.CHAT_S3_ENDPOINT!,
        accessKey: env.CHAT_S3_ACCESS_KEY!,
        secretKey: env.CHAT_S3_SECRET_KEY!,
        projectBucket: env.CHAT_S3_PROJECT_BUCKET!,
        personalBucket: env.CHAT_S3_PERSONAL_BUCKET!,
        region: env.CHAT_S3_REGION || 'us-east-1',
    };
}

/** Bounded S3 transport, exact-version reads and private bucket checks also work with Ceph RGW. */
export class ChatObjectStorage {
    readonly storageId: string;
    readonly client: Client;
    private readonly abortContext = new AsyncLocalStorage<AbortSignal | undefined>();
    constructor(
        readonly config: ChatS3Configuration,
        options: { allowInsecureLocal?: boolean; environment?: NodeJS.ProcessEnv } = {},
    ) {
        let url: URL;
        try {
            url = new URL(config.endpoint);
        } catch {
            throw new Error('Некорректный CHAT_S3_ENDPOINT.');
        }
        const env = options.environment ?? process.env,
            local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
        const bucketName = (value: string): boolean =>
            value.length >= 3 &&
            value.length <= 63 &&
            value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
            !/^\d+\.\d+\.\d+\.\d+$/.test(value);
        if (
            !['https:', 'http:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            (env.NODE_ENV === 'production' && url.protocol !== 'https:' && !(options.allowInsecureLocal && local)) ||
            !bucketName(config.projectBucket) ||
            !bucketName(config.personalBucket) ||
            config.projectBucket === config.personalBucket ||
            [config.accessKey, config.secretKey, config.region].some((value) => !value || /[\x00-\x20\x7f]/.test(value))
        ) {
            throw new Error('Нужны корректные отдельные закрытые бакеты и HTTPS-подключение CHAT_S3_*.');
        }
        this.storageId = chatObjectDigest(JSON.stringify([url.origin, config.projectBucket, config.personalBucket]));
        const transport = url.protocol === 'https:' ? https : http;
        const request = ((...args: Parameters<typeof http.request>) => {
            const outgoing = transport.request(...args),
                signal = this.abortContext.getStore();
            const abort = (): void => {
                outgoing.destroy(new Error('chat-s3-cancelled'));
            };
            const timer = setTimeout(() => outgoing.destroy(new Error('chat-s3-timeout')), 30000);
            timer.unref();
            outgoing.setTimeout(15000, () => outgoing.destroy(new Error('chat-s3-idle')));
            outgoing.once('close', () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
            });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            return outgoing;
        }) as typeof http.request;
        this.client = new Client({
            endPoint: url.hostname.replace(/^\[|\]$/g, ''),
            port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
            useSSL: url.protocol === 'https:',
            accessKey: config.accessKey,
            secretKey: config.secretKey,
            region: config.region,
            pathStyle: true,
            transport: { request },
            retryOptions: { disableRetry: true },
        });
    }
    /** Existing bucket policy and ACL are checked; public access is never silently overwritten. */
    async initialize(): Promise<void> {
        try {
            for (const bucket of [this.config.projectBucket, this.config.personalBucket]) {
                if (!(await this.client.bucketExists(bucket))) {
                    try {
                        await this.client.makeBucket(bucket, this.config.region);
                    } catch (error) {
                        if (code(error) !== 'BucketAlreadyOwnedByYou') throw error;
                    }
                }
                await assertPrivateS3Bucket(this.client, bucket);
            }
        } catch {
            throw unavailable();
        }
    }
    reference(reference: ChatObjectReference): void {
        if (
            reference.storage_id !== this.storageId ||
            ![this.config.projectBucket, this.config.personalBucket].includes(reference.bucket) ||
            !/^(?:projects\/[a-f0-9]{64}\/)?owners\/[a-f0-9]{64}\/chats\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(
                reference.object_key,
            ) ||
            !/^[a-f0-9]{64}$/.test(reference.sha256) ||
            !Number.isSafeInteger(reference.bytes) ||
            reference.bytes < 1 ||
            reference.bytes > 10 * 1024 ** 2
        ) {
            throw new ConflictException('Настройки хранилища или опись файла изменились.');
        }
    }
    async put(reference: ChatObjectReference, bytes: Buffer, signal?: AbortSignal): Promise<string | null> {
        this.reference(reference);
        if (bytes.length !== reference.bytes || chatObjectDigest(bytes) !== reference.sha256)
            throw new ConflictException('Контрольная сумма файла не совпала.');
        try {
            return await this.abortContext.run(signal, async () => {
                signal?.throwIfAborted();
                const result = await this.client.putObject(
                    reference.bucket,
                    reference.object_key,
                    bytes,
                    bytes.length,
                    { 'X-Amz-Meta-Neurocenter-Sha256': reference.sha256 },
                );
                return result.versionId && result.versionId !== 'null' ? result.versionId : null;
            });
        } catch {
            signal?.throwIfAborted();
            throw unavailable();
        }
    }
    async read(reference: ChatObjectReference, signal?: AbortSignal): Promise<Buffer> {
        this.reference(reference);
        try {
            return await this.abortContext.run(signal, async () => {
                signal?.throwIfAborted();
                const stream = await this.client.getObject(reference.bucket, reference.object_key, {
                    versionId: reference.version_id ?? 'null',
                });
                const abort = (): void => {
                    stream.destroy(new Error('chat-s3-cancelled'));
                };
                const timer = setTimeout(() => stream.destroy(new Error('chat-s3-read-timeout')), 30000);
                timer.unref();
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
                const chunks: Buffer[] = [];
                let size = 0;
                try {
                    for await (const part of stream) {
                        const bytes = Buffer.from(part);
                        size += bytes.length;
                        if (size > reference.bytes) throw new Error('large-object');
                        chunks.push(bytes);
                    }
                    const bytes = Buffer.concat(chunks);
                    if (bytes.length !== reference.bytes || chatObjectDigest(bytes) !== reference.sha256)
                        throw new Error('corrupt-object');
                    return bytes;
                } finally {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', abort);
                    stream.destroy();
                }
            });
        } catch {
            signal?.throwIfAborted();
            throw unavailable();
        }
    }
    /** A policy changed after startup must not publish a newly uploaded personal document. */
    async assertPrivate(reference: ChatObjectReference, signal?: AbortSignal): Promise<void> {
        this.reference(reference);
        try {
            signal?.throwIfAborted();
            await this.abortContext.run(signal, () => assertPrivateS3Bucket(this.client, reference.bucket));
            const url = new URL('/' + reference.bucket + '/' + reference.object_key, this.config.endpoint);
            const response = await fetch(url, {
                method: 'HEAD',
                redirect: 'error',
                signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
            });
            await response.body?.cancel();
            if (![401, 403, 404].includes(response.status)) throw new Error('public-object');
        } catch {
            signal?.throwIfAborted();
            throw unavailable();
        }
    }
    /** Keys contain a fresh nonce; purge all versions, including uncertain PUT acknowledgements. */
    async remove(reference: ChatObjectReference): Promise<void> {
        this.reference(reference);
        try {
            const stream = this.client.listObjects(reference.bucket, reference.object_key, true, {
                IncludeVersion: true,
            });
            const timer = setTimeout(() => stream.destroy(new Error('chat-s3-list-timeout')), 30000);
            timer.unref();
            let count = 0;
            try {
                for await (const raw of stream) {
                    const item = raw as { name?: string; versionId?: string };
                    if (++count > 128) throw new Error('too-many-object-versions');
                    if (item.name === reference.object_key)
                        await this.client.removeObject(reference.bucket, reference.object_key, {
                            versionId: item.versionId ?? 'null',
                        });
                }
            } finally {
                clearTimeout(timer);
                stream.destroy();
            }
        } catch {
            throw unavailable();
        }
    }
}
