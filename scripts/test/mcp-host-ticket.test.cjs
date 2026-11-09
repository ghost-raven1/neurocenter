const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    issueHostedMcpTicket,
    verifyHostedMcpTicket,
} = require('../../services/api-gateway/dist/features/mcp-host/ticket.js');
const { CEILING } = require('../../services/shared/runtime-artifacts.cjs');

test('Public host tickets never serialize private research process identity or caller extras', () => {
    const before = process.env.NEUROCENTER_MCP_HOST_SECRET;
    process.env.NEUROCENTER_MCP_HOST_SECRET = 'qa'.repeat(16);
    try {
        const claim = {
            artifactSha256: 'a'.repeat(64),
            entrypoint: 'server.mjs',
            executable: false,
            name: 'QA',
            compressedBytes: 12,
            session: {
                deviceId: 'device',
                projectId: 'project',
                assetId: 'asset',
                version: 1,
                manifest: 'b'.repeat(64),
            },
            researchSessionId: 'private-process-identity',
            unexpected: 'not-a-public-field',
        };
        const ticket = issueHostedMcpTicket(claim),
            raw = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url'));
        assert.equal(raw.researchSessionId, undefined);
        assert.equal(raw.unexpected, undefined);
        assert.deepEqual(verifyHostedMcpTicket(ticket), {
            artifactSha256: claim.artifactSha256,
            entrypoint: 'server.mjs',
            executable: false,
            name: 'QA',
            compressedBytes: 12,
            session: claim.session,
            exp: raw.exp,
        });
    } finally {
        if (before === undefined) delete process.env.NEUROCENTER_MCP_HOST_SECRET;
        else process.env.NEUROCENTER_MCP_HOST_SECRET = before;
    }
});

/** AD-3: verify проверяет claim против ceiling (контракт), а не против текущей политики. */
test('Verify: claim в пределах ceiling проходит, выше ceiling — invalid; политика env на ceiling не влияет', () => {
    const before = process.env.NEUROCENTER_MCP_HOST_SECRET;
    const beforePolicy = process.env.NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES;
    process.env.NEUROCENTER_MCP_HOST_SECRET = 'qa'.repeat(16); // AD-5: min-length 32
    const session = {
        deviceId: 'device',
        projectId: 'project',
        assetId: 'asset',
        version: 1,
        manifest: 'c'.repeat(64),
    };
    const claim = (overrides) => ({
        artifactSha256: 'd'.repeat(64),
        entrypoint: 'server.mjs',
        executable: false,
        name: 'QA',
        compressedBytes: CEILING.compressedBytes,
        unpackedBytes: CEILING.unpackedBytes,
        filesCount: CEILING.filesCount,
        session,
        ...overrides,
    });
    try {
        // Граница ceiling: ровно по каждой секции — проходит.
        const atCeiling = issueHostedMcpTicket(claim({}));
        assert.deepEqual(verifyHostedMcpTicket(atCeiling), {
            artifactSha256: claim({}).artifactSha256,
            entrypoint: 'server.mjs',
            executable: false,
            name: 'QA',
            compressedBytes: CEILING.compressedBytes,
            unpackedBytes: CEILING.unpackedBytes,
            filesCount: CEILING.filesCount,
            session,
            exp: JSON.parse(Buffer.from(atCeiling.split('.')[0], 'base64url')).exp,
        });
        // Расхождение 2 GiB vs 256 MiB закрыто: выше старой env-дефолтной политики, но ниже ceiling — принимается.
        const aboveOldDefault = issueHostedMcpTicket(claim({ compressedBytes: 256 * 1024 ** 2 + 1 }));
        assert.ok(verifyHostedMcpTicket(aboveOldDefault));
        // Выше ceiling по любой секции — invalid.
        for (const key of ['compressedBytes', 'unpackedBytes', 'filesCount']) {
            const ticket = issueHostedMcpTicket(claim({ [key]: CEILING[key] + 1 }));
            assert.equal(verifyHostedMcpTicket(ticket), undefined, key + ' выше ceiling обязан быть invalid');
        }
        // Политика env сужает только admission, не ceiling: verify против ceiling не меняется.
        process.env.NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES = '1024';
        try {
            assert.ok(verifyHostedMcpTicket(atCeiling));
        } finally {
            if (beforePolicy === undefined) delete process.env.NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES;
            else process.env.NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES = beforePolicy;
        }
    } finally {
        if (before === undefined) delete process.env.NEUROCENTER_MCP_HOST_SECRET;
        else process.env.NEUROCENTER_MCP_HOST_SECRET = before;
    }
});
