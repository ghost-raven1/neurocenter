/**
 * 6.6 (AD-O1/O2): integration check of the unified log schema + correlation id in api-gateway.
 *
 * express app (listen(0) + global fetch, no supertest): X-Request-ID middleware
 * before the logging handler, response header, and JSON lines on stdout
 * (write is resolved at call time — we can intercept it).
 * Plus source-level guard: in main.ts the request-context middleware
 * is wired up before the observability middleware.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'node:module';

// Нативный CJS require (createRequire): один экземпляр request-context.cjs на
// весь процесс — как в production. ESM-импорт через Vite дал бы второй
// AsyncLocalStorage, и логгер не видел бы контекст middleware.
const requireCjs = createRequire(import.meta.url);
const { createLogger } = requireCjs('../../../shared/logging.cjs');
const { createRequestContextMiddleware } = requireCjs('../../../shared/request-context.cjs');

const SERVICE = 'api-gateway';
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface IProbeResult {
    status: number;
    responseId: string | null;
    lines: Record<string, unknown>[];
}

/** One request to the express app: middleware → handler with JSON logging to stdout. */
async function probe(headers: Record<string, string> = {}): Promise<IProbeResult> {
    const app = express();
    const log = createLogger(SERVICE);
    app.use(createRequestContextMiddleware());
    app.get('/probe', (_req, res) => {
        log.info('probe', { probe: true });
        res.json({ ok: true });
    });
    const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    const written: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
    }) as unknown as typeof process.stdout.write;
    try {
        const response = await fetch(`http://127.0.0.1:${port}/probe`, { headers });
        return {
            status: response.status,
            responseId: response.headers.get('x-request-id'),
            lines: written
                .map((chunk) => chunk.trim())
                .filter((chunk) => chunk.startsWith('{'))
                .map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
        };
    } finally {
        process.stdout.write = original;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

describe('request-context + logging (api-gateway)', () => {
    it('without header — UUID4: response header and JSON line on stdout have the same requestId', async () => {
        const { status, responseId, lines } = await probe();
        expect(status).toBe(200);
        expect(responseId).toMatch(UUID4);
        const line = lines.find((l) => l.msg === 'probe');
        expect(line, 'JSON line of the probe handler should be written to stdout').toBeDefined();
        expect(line?.requestId).toBe(responseId);
        expect(line?.service).toBe(SERVICE);
        expect(line?.level).toBe('info');
        expect(line?.probe).toBe(true);
        expect(String(line?.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('valid incoming X-Request-ID is honored (nginx request_id) and echoed back in the response', async () => {
        const nginx = '6a2c1f0e9d8b7c6a5f4e3d2c1b0a9f8e';
        const { responseId, lines } = await probe({ 'x-request-id': nginx });
        expect(responseId).toBe(nginx);
        const line = lines.find((l) => l.msg === 'probe');
        expect(line?.requestId).toBe(nginx);
    });

    it('invalid header is regenerated as UUID4 (protection against spoofing)', async () => {
        const { responseId } = await probe({ 'x-request-id': 'bad id with spaces' });
        expect(responseId).toMatch(UUID4);
    });

    it('main.ts: request-context middleware is wired up before the observability middleware', () => {
        const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
        expect(main).toContain('createRequestContextMiddleware');
        const ctx = main.indexOf('app.use(createRequestContextMiddleware())');
        const obs = main.indexOf('app.use(createObservability');
        expect(ctx, 'main.ts should call app.use(createRequestContextMiddleware())').toBeGreaterThan(-1);
        expect(obs, 'main.ts should call the observability middleware').toBeGreaterThan(-1);
        expect(ctx, 'request-context middleware should be before observability (context for all middleware)').toBeLessThan(obs);
    });
});
