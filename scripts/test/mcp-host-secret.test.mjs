import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ticket from '../../services/api-gateway/dist/features/mcp-host/ticket.js';
import runtime from '../../services/shared/runtime.cjs';
import { configureProduction } from '../production/configuration.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { issueHostedMcpTicket, verifyHostedMcpTicket } = ticket;
const { validateProduction } = runtime;

const claim = () => ({
    artifactSha256: 'a'.repeat(64),
    descriptorSha256: 'e'.repeat(64),
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
});
const withHostSecret = (value, run) => {
    const before = process.env.NEUROCENTER_MCP_HOST_SECRET;
    const internalBefore = process.env.NEUROCENTER_INTERNAL_TOKEN;
    if (value === undefined) delete process.env.NEUROCENTER_MCP_HOST_SECRET;
    else process.env.NEUROCENTER_MCP_HOST_SECRET = value;
    try {
        return run();
    } finally {
        if (before === undefined) delete process.env.NEUROCENTER_MCP_HOST_SECRET;
        else process.env.NEUROCENTER_MCP_HOST_SECRET = before;
        if (internalBefore === undefined) delete process.env.NEUROCENTER_INTERNAL_TOKEN;
        else process.env.NEUROCENTER_INTERNAL_TOKEN = internalBefore;
    }
};
const productionEnv = (overrides = {}) => ({
    NODE_ENV: 'production',
    PANEL_URL: 'https://panel.example.test',
    NEUROCENTER_INTERNAL_TOKEN: 'a'.repeat(64),
    // entry 2.9 (AD-6): api-gateway обязан пройти и PG-цикл — URL той же БД, что и catalog.
    CATALOG_PG_URL: 'postgresql://runtime:test@postgres:5432/catalog',
    ...overrides,
});

test('AD-5: fallback на INTERNAL_TOKEN удалён — без host-секрета билеты не выпускаются', () => {
    const source = readFileSync(path.join(root, 'services/api-gateway/src/features/mcp-host/ticket.ts'), 'utf8');
    assert.ok(!source.includes('NEUROCENTER_INTERNAL_TOKEN'), 'ticket.ts снова читает NEUROCENTER_INTERNAL_TOKEN');
    process.env.NEUROCENTER_INTERNAL_TOKEN = 'a'.repeat(64);
    assert.throws(() => withHostSecret(undefined, () => issueHostedMcpTicket(claim())), /Секрет хоста MCP/);
    assert.equal(verifyHostedMcpTicket('payload.signature'), undefined);
});

test('AD-5: runtime-запас issue/verify — меньше 32 байт секрета не проходит', () => {
    assert.throws(() => withHostSecret('a'.repeat(31), () => issueHostedMcpTicket(claim())), /Секрет хоста MCP/);
    assert.equal(
        withHostSecret('a'.repeat(31), () => verifyHostedMcpTicket('payload.signature')),
        undefined,
    );
    const verified = withHostSecret('a'.repeat(32), () => verifyHostedMcpTicket(issueHostedMcpTicket(claim())));
    assert.ok(verified);
});

test('AD-5: validateProduction api-gateway — fail-fast без host-секрета', () => {
    assert.throws(() => validateProduction(productionEnv(), 'api-gateway'), /NEUROCENTER_MCP_HOST_SECRET/);
    assert.throws(
        () => validateProduction(productionEnv({ NEUROCENTER_MCP_HOST_SECRET: 'short' }), 'api-gateway'),
        /NEUROCENTER_MCP_HOST_SECRET/,
    );
    assert.throws(
        () => validateProduction(productionEnv({ NEUROCENTER_MCP_HOST_SECRET: 'a'.repeat(63) }), 'api-gateway'),
        /NEUROCENTER_MCP_HOST_SECRET/,
    );
});

test('AD-5: validateProduction api-gateway — совпадение с internal-токеном запрещено (timing-safe)', () => {
    assert.throws(
        () => validateProduction(productionEnv({ NEUROCENTER_MCP_HOST_SECRET: 'a'.repeat(64) }), 'api-gateway'),
        /NEUROCENTER_MCP_HOST_SECRET/,
    );
    assert.throws(
        () =>
            validateProduction(
                productionEnv({
                    NEUROCENTER_MCP_HOST_SECRET: 'a'.repeat(64),
                    NEUROCENTER_INTERNAL_TOKEN: 'a'.repeat(64),
                }),
                'api-gateway',
            ),
        /разные trust-domain/,
    );
    assert.doesNotThrow(() =>
        validateProduction(productionEnv({ NEUROCENTER_MCP_HOST_SECRET: 'b'.repeat(64) }), 'api-gateway'),
    );
});

test('AD-5: production setup генерирует mcp_host_secret независимо от internal_token', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nc-mcp-host-secret-'));
    try {
        await configureProduction(
            {
                panelUrl: 'https://panel.example.test',
                ssoHost: 'https://blitz.example.test',
                ssoClientId: 'test-client',
                ssoClientSecret: 'fixture-only',
                adminEmail: 'Admin@example.test',
                release: 'test-20261109',
                tlsCertFile: '/test/tls.crt',
                tlsKeyFile: '/test/tls.key',
            },
            directory,
        );
        const host = await readFile(path.join(directory, 'secrets/mcp_host_secret'), 'utf8');
        const internal = await readFile(path.join(directory, 'secrets/internal_token'), 'utf8');
        assert.match(host.trim(), /^[a-f0-9]{64}$/);
        assert.notEqual(host, internal, 'mcp_host_secret обязан отличаться от internal_token');
        await configureProduction(
            {
                panelUrl: 'https://panel.example.test',
                ssoHost: 'https://blitz.example.test',
                ssoClientId: 'test-client',
                ssoClientSecret: 'fixture-only',
                adminEmail: 'Admin@example.test',
                release: 'test-20261109',
                tlsCertFile: '/test/tls.crt',
                tlsKeyFile: '/test/tls.key',
            },
            directory,
        );
        assert.equal(await readFile(path.join(directory, 'secrets/mcp_host_secret'), 'utf8'), host);
        assert.ok(!(await readFile(path.join(directory, '.env'), 'utf8')).includes(host.trim()));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('AD-5: nginx access-log маскирует m/:ticket, другие пути остаются как есть', async () => {
    const template = await readFile(path.join(root, 'frontend/nginx.production.conf.template'), 'utf8');
    assert.match(template, /log_format\s+neurocenter[^;]*"path":"\$log_path"/);
    assert.ok(!template.includes('"path":"$uri"'), 'log_format снова пишет сырой $uri');
    const mapBlock = template.match(/map\s+\$uri\s+\$log_path\s*\{([\s\S]*?)\n\}/);
    assert.ok(mapBlock, 'map $uri $log_path не найден');
    const rule = mapBlock[1].match(/~([^;]+?)\s+([^;\s]+)\s*;\s*\n\s*default\s+\$uri\s*;/);
    assert.ok(rule, 'правило маскировки m/:ticket и default $uri');
    const redactPattern = new RegExp(rule[1]);
    const loggedPath = (uri) => (redactPattern.test(uri) ? rule[2] : uri);
    const ticketValue = 'eyJhbGciOiJub25lIn0.c2VjcmV0LXRpY2tldA';
    assert.equal(loggedPath('/api/mcp-host/m/' + ticketValue), '/api/mcp-host/m/[REDACTED]');
    assert.ok(!loggedPath('/api/mcp-host/m/' + ticketValue).includes(ticketValue));
    assert.equal(loggedPath('/api/mcp-host/m'), '/api/mcp-host/m');
    assert.equal(loggedPath('/api/mcp-host/m/'), '/api/mcp-host/m/');
    assert.equal(loggedPath('/api/mcp-host/connect'), '/api/mcp-host/connect');
    assert.equal(loggedPath('/api/other'), '/api/other');
});
