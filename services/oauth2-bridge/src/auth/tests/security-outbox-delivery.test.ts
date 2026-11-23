import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecurityOutbox, deliverSecurityEvents } from '../../../../shared/security-outbox.cjs';

/**
 * P0-RES/AD-O7: outbox-доставка security-событий в catalog.
 * «kill catalog» эмулируется 500 от фейкового каталога: событие остаётся
 * в outbox-файле и доставляется после восстановления (retry), не теряется.
 * Идемпотентность — стабильный eventId (catalog дедуплицирует ON CONFLICT).
 */
const TOKEN = 'test-internal-token';
let mode: 'ok' | 'fail' = 'ok';
const received: Array<{ token: string; events: Array<Record<string, unknown>> }> = [];
let server: http.Server;
let dir: string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    for (;;) {
        if (await cond()) return;
        if (Date.now() - start > timeoutMs) throw new Error('timeout: ожидаемое состояние не наступило');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === '/internal/security-events' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                if (req.headers['x-neurocenter-internal'] !== TOKEN) {
                    res.statusCode = 403;
                    res.end();
                    return;
                }
                if (mode === 'fail') {
                    res.statusCode = 500;
                    res.end('down');
                    return;
                }
                const data = JSON.parse(body) as { events: Array<Record<string, unknown>> };
                received.push({ token: String(req.headers['x-neurocenter-internal']), events: data.events });
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ received: data.events.length }));
            });
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    process.env.CATALOG_SERVICE_URL = `http://127.0.0.1:${port}`;
    process.env.NEUROCENTER_INTERNAL_TOKEN = TOKEN;
    dir = await mkdtemp(path.join(tmpdir(), 'nc-security-outbox-'));
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
});

describe('FR-903/AD-O7: outbox — доставка, kill catalog → retry', () => {
    it('событие доставляется в catalog с internal-токеном и eventId, файл удаляется', async () => {
        const outbox = new SecurityOutbox(dir, deliverSecurityEvents, { intervalMs: 30 });
        await outbox.start();
        try {
            const saved = await outbox.append([{ actor: 'u@local', action: 'login.success', resourceId: 'u@local', before: null, after: null }]);
            expect(saved).toBe(1);
            await waitFor(() => received.length === 1);
            expect(received[0]!.token).toBe(TOKEN);
            const event = received[0]!.events[0]!;
            expect(event.eventId).toMatch(UUID_RE);
            expect(event.action).toBe('login.success');
            // файл outbox удаляется после подтверждения каталогом
            await waitFor(async () => (await outbox.pending()) === false);
        } finally {
            await outbox.stop();
        }
    });

    it('catalog down (500): событие остаётся в outbox и доставляется после восстановления', async () => {
        const outbox = new SecurityOutbox(dir, deliverSecurityEvents, { intervalMs: 30 });
        await outbox.start();
        try {
            mode = 'fail';
            await outbox.append([{ actor: '1.2.3.4', action: 'login.failure', resourceId: 'login', before: null, after: { reason: 'exchange' } }]);
            await outbox.tryFlush(); // явная попытка доставки при down-каталоге (ошибка глотается, файл остаётся)
            expect(await outbox.pending()).toBe(true);
            expect(received.length).toBe(1);

            mode = 'ok';
            await waitFor(() => received.length === 2);
            await waitFor(async () => (await outbox.pending()) === false);
            const redelivered = received[1]!.events[0]!;
            expect(redelivered.action).toBe('login.failure');
            // стабильный eventId: повторная доставка не создаст дубль в catalog
            expect(redelivered.eventId).toMatch(UUID_RE);
        } finally {
            await outbox.stop();
        }
    });
});
