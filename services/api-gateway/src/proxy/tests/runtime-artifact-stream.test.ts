import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardRuntimeArtifact } from '../runtime-artifact-stream';

const job = {
    id: '11111111-1111-4111-8111-111111111111',
    lease: '22222222-2222-4222-8222-222222222222',
};
const sha = 'ab'.repeat(32);
const SUFFIX = 'jobs/' + job.id + '/runtime/' + sha;
const FULL_PATH = '/api/device-channel/' + SUFFIX;
const servers: http.Server[] = [];

interface IUpstreamConfig {
    signal: AbortSignal;
    headers: Record<string, string>;
}
interface IUpstream {
    status: number;
    headers: Record<string, string>;
    data: Readable;
}

/** Реальный http-сервер имитирует сторону устройства; express-семантика req.path воспроизводится вручную. */
async function fixture(
    upstream: (url: string, config: IUpstreamConfig) => Promise<IUpstream>,
): Promise<{ port: number; get: ReturnType<typeof vi.fn>; close: () => Promise<void> }> {
    const get = vi.fn(upstream);
    const server = http.createServer((req, res) => {
        // Express-семантика, которой нет у http.ServerResponse: res.status(...).json(...).
        const express = {
            status(code: number) {
                res.statusCode = code;
                return express;
            },
            json(body: unknown) {
                const text = JSON.stringify(body);
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.setHeader('content-length', String(Buffer.byteLength(text)));
                res.end(text);
                return express;
            },
        };
        (req as { path?: string }).path = req.url;
        void forwardRuntimeArtifact(
            { get } as unknown as AxiosInstance,
            'http://catalog.invalid',
            SUFFIX,
            req as never,
            Object.assign(res, express) as never,
        );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        port,
        get,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

function request(
    port: number,
    onResponse?: (res: http.IncomingMessage) => void,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; error: Error | undefined }> {
    return new Promise((resolve) => {
        const req = http.get(
            {
                host: '127.0.0.1',
                port,
                path: FULL_PATH,
                headers: { authorization: 'Bearer tok', 'x-neurocenter-job-lease': job.lease },
            },
            (res) => {
                onResponse?.(res);
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), error: undefined }),
                );
                res.on('error', (error) =>
                    resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), error: error as Error }),
                );
                // destroy() по инициативе клиента: 'end'/'error' не наступают, завершаем по 'close'.
                res.on('close', () =>
                    resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), error: undefined }),
                );
            },
        );
        req.on('error', (error) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: error as Error }));
    });
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > ms) throw new Error('Срок ожидания истёк.');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

describe('forwardRuntimeArtifact — стрим одобренного артефакта (AD-D5)', () => {
    it('Стрим без буферизации: заголовки, все байты и lease-хедер к каталогу', async () => {
        const bytes = Buffer.alloc(3 * 1024 * 1024, 0x61);
        const f = await fixture(async (url) => ({
            status: 200,
            headers: { 'content-length': String(bytes.length) },
            data: Readable.from([bytes]),
        }));
        try {
            const res = await request(f.port);
            expect(res.status).toBe(200);
            expect(res.error).toBeUndefined();
            expect(res.headers['content-type']).toBe('application/gzip');
            expect(res.headers['content-length']).toBe(String(bytes.length));
            expect(res.headers['cache-control']).toBe('no-store');
            expect(res.body.equals(bytes)).toBe(true);
            expect(f.get).toHaveBeenCalledTimes(1);
            expect(f.get.mock.calls[0]![0]).toBe('http://catalog.invalid/internal/device-channel/' + SUFFIX);
            const config = f.get.mock.calls[0]![1] as IUpstreamConfig;
            expect(config.headers).toEqual({
                authorization: 'Bearer tok',
                'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                'x-neurocenter-job-lease': job.lease,
            });
            // AD-D5 (OQ-3: б): gateway не считает SHA — целостность верифицирует клиент; стрим не буферизуется.
            expect(res.headers['x-neurocenter-sha256']).toBeUndefined();
        } finally {
            await f.close();
        }
    });
    it.each([
        [401, 401],
        [403, 403],
        [404, 404],
        [409, 409],
        [500, 502],
    ])('Upstream %i → %i до отдачи тела', async (upstream, expected) => {
        const f = await fixture(async () => ({
            status: upstream,
            headers: {},
            data: Readable.from([Buffer.from('x')]),
        }));
        try {
            const res = await request(f.port);
            expect(res.status).toBe(expected);
            expect(res.body.toString()).toContain('Артефакт недоступен');
        } finally {
            await f.close();
        }
    });
    it.each([undefined, 'abc', '0', '-4'])(
        'Некорректный content-length %s → 502 до отдачи тела',
        async (length) => {
            const f = await fixture(async () => ({
                status: 200,
                headers: length === undefined ? {} : { 'content-length': length },
                data: Readable.from([Buffer.from('abcd')]),
            }));
            try {
                const res = await request(f.port);
                expect(res.status).toBe(502);
                expect(res.body.toString()).toContain('Некорректный размер');
            } finally {
                await f.close();
            }
        },
    );
    it('Бюджет политики 256MiB: объявленный размер выше → 502 (length-чек сохранён)', async () => {
        const f = await fixture(async () => ({
            status: 200,
            headers: { 'content-length': String(256 * 1024 ** 2 + 1) },
            data: Readable.from([Buffer.alloc(1)]),
        }));
        try {
            const res = await request(f.port);
            expect(res.status).toBe(502);
            expect(res.body.toString()).toContain('Некорректный размер');
        } finally {
            await f.close();
        }
    });
    it('received > length: стрим прерывается, лишние байты устройству не отдают', async () => {
        const declared = Buffer.alloc(4, 1),
            extra = Buffer.alloc(4, 2),
            data = Readable.from([declared, extra]);
        const f = await fixture(async () => ({
            status: 200,
            headers: { 'content-length': String(declared.length) },
            data,
        }));
        try {
            const res = await request(f.port);
            // Устройству отданы ровно объявленные байты; upstream-поток разрушен, extra не читаются.
            expect(res.status).toBe(200);
            expect(res.body.equals(declared)).toBe(true);
            await until(() => data.destroyed);
            expect(data.destroyed).toBe(true);
        } finally {
            await f.close();
        }
    });
    it('Отключение клиента завершает только его upstream (abort)', async () => {
        const data = new Readable({ read() {} });
        const f = await fixture(async () => {
            data.push(Buffer.alloc(4)); // первый чанк, чтобы заголовки дошли до клиента; далее поток «висит»
            return { status: 200, headers: { 'content-length': '8' }, data };
        });
        try {
            let headersSeen = false;
            await request(f.port, (res) => {
                headersSeen = true;
                res.destroy();
            });
            expect(headersSeen).toBe(true);
            const config = f.get.mock.calls[0]![1] as IUpstreamConfig;
            await until(() => config.signal.aborted);
            expect(config.signal.aborted).toBe(true);
        } finally {
            await f.close();
        }
    });
});
