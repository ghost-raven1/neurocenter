import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withDockerBuildCa } from '../workspace/docker-build-ca.mjs';
import { withNpmBuildEnvironment } from '../workspace/npm-build-environment.mjs';
import { projectConfig, projectTlsEnvironment } from '../workspace/project-config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const { validateProduction } = require('../../services/shared/runtime.cjs');

const dockerfiles = [
    'services/api-gateway/Dockerfile',
    'services/catalog-service/Dockerfile',
    'services/feature-flags-service/Dockerfile',
    'services/oauth2-bridge/Dockerfile',
    'services/rag-sync-service/Dockerfile',
    'services/skills-service/Dockerfile',
    'frontend/Dockerfile',
];
const npmrcFiles = [
    '.npmrc',
    'mcp/neurocenter-asset-sync/.npmrc',
    'frontend/.npmrc',
    'services/api-gateway/.npmrc',
    'services/catalog-service/.npmrc',
    'services/feature-flags-service/.npmrc',
    'services/oauth2-bridge/.npmrc',
    'services/rag-sync-service/.npmrc',
    'services/skills-service/.npmrc',
];
const hostScripts = [
    'scripts/workspace/docker-build-ca.mjs',
    'scripts/workspace/npm-build-environment.mjs',
    'scripts/workspace/check.mjs',
    'scripts/workspace/isolated-build.mjs',
    'scripts/workspace/dev-watch-runtime.mjs',
    'scripts/prepare-opencode.mjs',
    'scripts/catalog-plugins/recipes/upstream.mjs',
    'scripts/dev.mjs',
    'scripts/docker-build.mjs',
    'scripts/production/setup.mjs',
];
const runtimeFiles = [
    'services/api-gateway/src/main.ts',
    'services/shared/runtime.cjs',
    'services/catalog-service/src/package-build/npm-source-transport.ts',
];
const tlsOffPatterns = [/NODE_TLS_REJECT_UNAUTHORIZED=0/, /strict-ssl=false/, /rejectUnauthorized:\s*false/];

async function source(file) {
    return fs.readFile(path.join(root, file), 'utf8');
}

test('Статический обзор: независимых отключений TLS вне вывода из флага нет', async () => {
    for (const file of [
        ...dockerfiles,
        'compose.production.yml',
        'docker-compose.yml',
        ...npmrcFiles,
        ...runtimeFiles,
        ...hostScripts,
    ]) {
        const text = await source(file);
        for (const pattern of tlsOffPatterns) assert.doesNotMatch(text, pattern, file);
    }
    for (const file of npmrcFiles) {
        const text = await source(file);
        assert.doesNotMatch(text, /node-options=/, file + ': preload-отключение запрещено');
    }
    assert.doesNotMatch(await source('services/api-gateway/Dockerfile'), /ENV NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.doesNotMatch(await source('services/shared/runtime.cjs'), /service !== 'api-gateway'/);
    assert.doesNotMatch(await source('services/api-gateway/src/main.ts'), /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('Вывод из флага закреплён во всех Dockerfile, compose и host-скриптах', async () => {
    for (const file of dockerfiles) {
        const text = await source(file);
        assert.match(text, /^ARG NEUROCENTER_TLS_DISABLE=0$/m, file);
        assert.match(text, /^ARG NEUROCENTER_NPM_STRICT_SSL=true$/m, file);
        assert.match(text, /NPM_CONFIG_STRICT_SSL=\$NEUROCENTER_NPM_STRICT_SSL/, file);
        for (const line of text.split('\n'))
            if (/^RUN .*npm (ci|install)/.test(line)) {
                assert.match(
                    line,
                    /NODE_TLS_REJECT_UNAUTHORIZED="\$\(if \[ "\$NEUROCENTER_TLS_DISABLE" = "1" \]; then printf 0; else printf 1; fi\)"/,
                    file,
                );
                assert.match(line, /--strict-ssl="\$NEUROCENTER_NPM_STRICT_SSL"/, file);
            }
    }
    const dev = await source('docker-compose.yml'),
        prod = await source('compose.production.yml');
    assert.equal((dev.match(/NEUROCENTER_TLS_DISABLE: \$\{NEUROCENTER_TLS_DISABLE:-0\}/g) ?? []).length, 7);
    assert.equal((dev.match(/NEUROCENTER_NPM_STRICT_SSL: \$\{NEUROCENTER_NPM_STRICT_SSL:-true\}/g) ?? []).length, 7);
    assert.equal((dev.match(/NODE_TLS_REJECT_UNAUTHORIZED=\$\{NODE_TLS_REJECT_UNAUTHORIZED:-1\}/g) ?? []).length, 1);
    assert.equal((prod.match(/NEUROCENTER_TLS_DISABLE: "\$\{NEUROCENTER_TLS_DISABLE:-0\}"/g) ?? []).length, 8);
    assert.equal((prod.match(/NEUROCENTER_NPM_STRICT_SSL: "\$\{NEUROCENTER_NPM_STRICT_SSL:-true\}"/g) ?? []).length, 8);
    const setup = await source('scripts/production/setup.mjs');
    assert.match(setup, /NEUROCENTER_TLS_DISABLE: '0'/, 'production-сборка форсирует strict');
    assert.match(await source('scripts/workspace/dev-watch-runtime.mjs'), /NODE_TLS_REJECT_UNAUTHORIZED \?\? '1'/);
    assert.match(await source('.gitignore'), /neurocenter\.config\.local\.json/);
});

test('Закреплённый dev-дефолт флага в neurocenter.config.json — true', async () => {
    const config = JSON.parse(await source('neurocenter.config.json'));
    assert.equal(config.tls.disableTlsVerification, true);
    assert.deepEqual(await projectConfig(root), config);
});

test('project-config: strict-схема, local-override и приоритет явного значения', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nc project config '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const put = async (name, value) =>
        fs.writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    assert.deepEqual(await projectTlsEnvironment(directory), {
        NEUROCENTER_TLS_DISABLE: '0',
        NEUROCENTER_NPM_STRICT_SSL: 'true',
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
    });
    await put('neurocenter.config.json', { tls: { disableTlsVerification: true } });
    assert.deepEqual(await projectTlsEnvironment(directory), {
        NEUROCENTER_TLS_DISABLE: '1',
        NEUROCENTER_NPM_STRICT_SSL: 'false',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    await put('neurocenter.config.local.json', { tls: { disableTlsVerification: false } });
    assert.equal((await projectConfig(directory)).tls.disableTlsVerification, false);
    assert.equal((await projectTlsEnvironment(directory)).NEUROCENTER_TLS_DISABLE, '0');
    assert.deepEqual(await projectTlsEnvironment(directory, { NEUROCENTER_TLS_DISABLE: '1' }), {
        NEUROCENTER_TLS_DISABLE: '1',
        NEUROCENTER_NPM_STRICT_SSL: 'false',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    await assert.rejects(() => projectTlsEnvironment(directory, { NEUROCENTER_TLS_DISABLE: '2' }), /0 или 1/);
    await put('neurocenter.config.local.json', { tls: { disableTlsVerification: false, other: true } });
    await assert.rejects(() => projectConfig(directory), /Неизвестный ключ/);
    await put('neurocenter.config.json', '{broken');
    await assert.rejects(() => projectConfig(directory), /JSON/);
});

test('withNpmBuildEnvironment и withDockerBuildCa выводят значения из флага', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nc tls derivation '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const off = await fs.mkdtemp(path.join(directory, 'off')),
        on = await fs.mkdtemp(path.join(directory, 'on'));
    t.after(() => fs.rm(on, { recursive: true, force: true }));
    await fs.writeFile(
        path.join(off, 'neurocenter.config.json'),
        JSON.stringify({ tls: { disableTlsVerification: true } }),
    );
    await fs.writeFile(
        path.join(on, 'neurocenter.config.json'),
        JSON.stringify({ tls: { disableTlsVerification: false } }),
    );
    for (const [fixture, tls] of [
        [off, { NEUROCENTER_TLS_DISABLE: '1', NEUROCENTER_NPM_STRICT_SSL: 'false', NODE_TLS_REJECT_UNAUTHORIZED: '0' }],
        [on, { NEUROCENTER_TLS_DISABLE: '0', NEUROCENTER_NPM_STRICT_SSL: 'true', NODE_TLS_REJECT_UNAUTHORIZED: '1' }],
    ]) {
        const captured = {};
        await withNpmBuildEnvironment(
            {},
            async (options) => {
                Object.assign(captured, options);
            },
            fixture,
        );
        assert.ok(captured.args.includes('--strict-ssl=' + tls.NEUROCENTER_NPM_STRICT_SSL), fixture);
        assert.equal(captured.env.NODE_TLS_REJECT_UNAUTHORIZED, tls.NODE_TLS_REJECT_UNAUTHORIZED, fixture);
        assert.equal(captured.env.NPM_CONFIG_STRICT_SSL, tls.NEUROCENTER_NPM_STRICT_SSL, fixture);
        const build = {};
        await withDockerBuildCa(fixture, {}, async ({ environment, args }) => {
            build.environment = environment;
            build.args = args;
        });
        assert.equal(build.environment.NEUROCENTER_TLS_DISABLE, tls.NEUROCENTER_TLS_DISABLE, fixture);
        assert.equal(build.environment.NEUROCENTER_NPM_STRICT_SSL, tls.NEUROCENTER_NPM_STRICT_SSL, fixture);
        assert.deepEqual(build.args, []);
    }
    const forced = {};
    await withDockerBuildCa(off, { NEUROCENTER_TLS_DISABLE: '0' }, async ({ environment }) => {
        Object.assign(forced, environment);
    });
    assert.equal(forced.NEUROCENTER_TLS_DISABLE, '0');
    assert.equal(forced.NEUROCENTER_NPM_STRICT_SSL, 'true');
});

test('validateProduction отклоняет отключённую проверку TLS для любого сервиса, включая api-gateway', () => {
    const env = {
        NODE_ENV: 'production',
        SSO_DISABLE: 'false',
        PANEL_URL: 'https://panel.example.test',
        SSO_HOST: 'https://sso.example.test',
        REDIRECT_URI: 'https://panel.example.test/auth/callback',
        SSO_CLIENT_ID: 'production-client',
        SSO_CLIENT_SECRET: 'test-only-secret',
        NEUROCENTER_INTERNAL_TOKEN: 'a'.repeat(64),
        NEUROCENTER_MCP_HOST_SECRET: 'b'.repeat(64),
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        CATALOG_PG_URL: 'postgresql://catalog:fixture@postgres/catalog',
        RAG_PG_URL: 'postgresql://backup:fixture@postgres/rag',
        CATALOG_SERVICE_URL: 'http://catalog-service:4100',
        SKILLS_SERVICE_URL: 'http://skills-service:4200',
        RAG_SERVICE_URL: 'http://rag-sync-service:4300',
        AUTH_SERVICE_URL: 'http://oauth2-bridge:22222',
        FEATURE_FLAGS_SERVICE_URL: 'http://feature-flags-service:4400',
    };
    for (const service of [
        'api-gateway',
        'catalog-service',
        'skills-service',
        'rag-sync-service',
        'feature-flags-service',
        'oauth2-bridge',
        'bootstrap-admin',
    ])
        assert.throws(() => validateProduction(env, service), /TLS/, service);
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    assert.doesNotThrow(() => validateProduction(env, 'api-gateway'));
});

test('Production-сборка форсирует strict независимо от флага в конфиге', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nc production force '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(
        path.join(directory, 'neurocenter.config.json'),
        JSON.stringify({ tls: { disableTlsVerification: true } }),
    );
    for (const context of ['docker/build-ca', 'frontend/docker/build-ca'])
        await fs.mkdir(path.join(directory, context), { recursive: true });
    const environment = {};
    await withDockerBuildCa(directory, { ...process.env, NEUROCENTER_TLS_DISABLE: '0' }, async (options) => {
        Object.assign(environment, options.environment);
    });
    assert.equal(environment.NEUROCENTER_TLS_DISABLE, '0');
    assert.equal(environment.NEUROCENTER_NPM_STRICT_SSL, 'true');
    assert.match(
        await source('scripts/production/setup.mjs'),
        /withDockerBuildCa\(releaseRoot, \{ \.\.\.source, NEUROCENTER_TLS_DISABLE: '0' \}, action\)/,
    );
});

test('Strict-исходящий вызов отклоняет self-signed; с NODE_EXTRA_CA_CERTS вызов проходит', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nc tls outbound '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const key = path.join(directory, 'key.pem'),
        cert = path.join(directory, 'cert.pem');
    const generated = spawnSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-keyout',
            key,
            '-out',
            cert,
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const server = https.createServer(
        { key: await fs.readFile(key), cert: await fs.readFile(cert) },
        (_request, response) => response.end('tls-outbound-ok'),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port,
        program = `require('https').get('https://127.0.0.1:${port}',response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>console.log(JSON.stringify({status:response.statusCode,body})));}).on('error',error=>console.log(JSON.stringify({error:error.code})));`;
    const probe = async (extra = {}) => {
        const child = spawn(process.execPath, ['-e', program], {
            env: { PATH: process.env.PATH, ...extra },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (bytes) => (stdout += bytes));
        child.stderr.on('data', (bytes) => (stderr += bytes));
        const code = await new Promise((resolve) => child.once('exit', resolve));
        assert.equal(code, 0, stderr);
        return JSON.parse(stdout);
    };
    const strict = await probe();
    assert.ok(strict.error, 'self-signed должен быть отклонён');
    assert.match(String(strict.error), /SELF_SIGNED|CERT/);
    const relaxed = await probe({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.deepEqual(relaxed, { status: 200, body: 'tls-outbound-ok' });
    const trusted = await probe({ NODE_EXTRA_CA_CERTS: cert });
    assert.deepEqual(trusted, { status: 200, body: 'tls-outbound-ok' });
});
