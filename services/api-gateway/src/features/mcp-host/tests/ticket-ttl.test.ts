import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOSTED_MCP_TTL_MS, issueHostedMcpTicket } from '../ticket';

const claim = () => ({
    artifactSha256: 'a'.repeat(64),
    descriptorSha256: 'e'.repeat(64),
    entrypoint: 'server.mjs',
    executable: false,
    name: 'TTL',
    compressedBytes: 12,
    session: {
        deviceId: 'device',
        projectId: 'project',
        assetId: 'asset',
        version: 1,
        manifest: 'b'.repeat(64),
    },
});

describe('TTL билета хоста (AD-4)', () => {
    const SECRET = 'qa'.repeat(16);
    beforeEach(() => {
        process.env.NEUROCENTER_MCP_HOST_SECRET = SECRET;
    });
    afterEach(() => {
        delete process.env.NEUROCENTER_MCP_HOST_SECRET;
    });

    it('HOSTED_MCP_TTL_MS = 24h (было 30 дней)', () => {
        expect(HOSTED_MCP_TTL_MS).toBe(24 * 3600 * 1000);
    });

    it('issuance: exp = now + 24h, не 30 дней', () => {
        const before = Date.now();
        const ticket = issueHostedMcpTicket(claim());
        const after = Date.now();
        const raw = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url')) as { exp: number };
        expect(raw.exp).toBeGreaterThanOrEqual(before + HOSTED_MCP_TTL_MS);
        expect(raw.exp).toBeLessThanOrEqual(after + HOSTED_MCP_TTL_MS);
        // Явная граница «не 30d»: exp обязан быть ближе, чем 48h от момента выпуска.
        expect(raw.exp - after).toBeLessThanOrEqual(48 * 3600 * 1000);
    });
});
