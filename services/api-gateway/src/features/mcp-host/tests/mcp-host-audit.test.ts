import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { McpHostController } from '../mcp-host.controller';
import { issueHostedMcpTicket } from '../ticket';

/**
 * P0-RES/AD-O7: security-события верификации билета хоста MCP.
 * ticket.granted — eventId = sha256(билета) (креденциал в событие не идёт,
 * дедупликация кросс-реплик — ON CONFLICT в catalog); ticket.denied — на каждый
 * отказ верификации, actor = адрес запроса.
 */
process.env.NEUROCENTER_MCP_HOST_SECRET = 'x'.repeat(48);

const session = {
    deviceId: 'dev-1',
    projectId: 'p-1',
    assetId: 'asset-1',
    version: 1,
    manifest: 'c'.repeat(64),
};
const ticket = issueHostedMcpTicket({
    artifactSha256: 'a'.repeat(64),
    descriptorSha256: 'd'.repeat(64),
    entrypoint: 'index.js',
    executable: false,
    name: 'test-mcp',
    compressedBytes: 100,
    session,
});

function makeController() {
    const events: Array<Record<string, unknown>> = [];
    const config = {
        get: (key: string, fallback?: unknown) => (key === 'CATALOG_SERVICE_URL' ? 'http://localhost:4100' : fallback),
    };
    const audit = { event: (e: Record<string, unknown>) => events.push(e) };
    const controller = new McpHostController({} as never, config as never, audit as never);
    (
        controller as unknown as {
            host: { handle: (claim: unknown, req: unknown, res: unknown) => Promise<void>; onModuleDestroy: () => Promise<void> };
        }
    ).host = {
        handle: async () => undefined,
        onModuleDestroy: async () => undefined,
    };
    const res = {
        status: (code: number) => {
            res.statusCalled = code;
            return res;
        },
        json: () => undefined,
        headersSent: false,
        writableEnded: false,
        statusCalled: 0 as number,
    };
    const req = { ip: '9.9.9.9' };
    return { controller, events, res, req };
}

describe('FR-903/AD-O7: ticket.granted / ticket.denied security-события (api-gateway)', () => {
    it('битый билет → ticket.denied (actor = адрес, reason=invalid-ticket), 401', async () => {
        const { controller, events, res, req } = makeController();
        await controller.channel(req as never, res as never, 'not-a-ticket');
        await controller.onModuleDestroy();
        expect(res.statusCalled).toBe(401);
        expect(events).toEqual([
            {
                actor: '9.9.9.9',
                action: 'ticket.denied',
                resourceId: 'mcp-ticket',
                before: null,
                after: { reason: 'invalid-ticket' },
            },
        ]);
        // сам битый билет (креденциал) в событие не попадает
        expect(JSON.stringify(events)).not.toContain('not-a-ticket');
    });

    it('валидный билет → ticket.granted; eventId = sha256(билета), actor = device', async () => {
        const { controller, events, res, req } = makeController();
        await controller.channel(req as never, res as never, ticket);
        await controller.onModuleDestroy();
        expect(res.statusCalled).toBe(0); // 4xx/5xx не выставлены — канал передан хосту
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event).toEqual({
            eventId: createHash('sha256').update(ticket).digest('hex'),
            actor: 'dev-1',
            action: 'ticket.granted',
            resourceId: 'asset-1',
            before: null,
            after: { deviceId: 'dev-1', projectId: 'p-1' },
        });
        // сам билет (HMAC-креденциал) в событие не попадает
        expect(JSON.stringify(events)).not.toContain(ticket);
    });
});
