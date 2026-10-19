import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { publicationKey, readyManifest } from '../catalog-plugins/manifest.mjs';
import { parseArguments, publishCatalog } from '../catalog-plugins/publish.mjs';

const { artifactFixture } = createRequire(import.meta.url)('./runtime-artifact-fixture.cjs');
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-plugin-publish-'));
    roots.push(root);
    const { archive, descriptor } = artifactFixture();
    await writeFile(path.join(root, 'runtime.tar.gz'), archive);
    await writeFile(path.join(root, 'descriptor.json'), JSON.stringify(descriptor));
    const tool = { key: 'example-plugin', publication: { name: 'Example plugin', kind: 'plugin', description: 'Проверочный плагин', origin: 'npm:example-plugin', revision: '1.2.3',
        config: { extra: { runtimeArtifacts: [descriptor] } } }, artifacts: [{ archivePath: 'runtime.tar.gz', descriptorPath: 'descriptor.json' }] };
    const manifest = path.join(root, 'ready.json');
    const save = async (tools = [tool]) => { await writeFile(manifest, JSON.stringify({ schemaVersion: 1, tools })); };
    await save();
    return { root, manifest, tool, descriptor, save };
}

test('Ключ публикации стабилен для закреплённой ревизии и меняется для другой версии', () => {
    const key = publicationKey('package-name', '1.2.3');
    assert.match(key, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(publicationKey('package-name', '1.2.3'), key);
    assert.notEqual(publicationKey('package-name', '1.2.4'), key);
    assert.notEqual(publicationKey('other-package', '1.2.3'), key);
});

test('Пути архивов считаются от manifest, а dry-run не обращается к сети и не пишет файлы', async () => {
    const f = await fixture();
    const before = await readdir(f.root);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Dry-run обратился к сети'); };
    try {
        const tools = await readyManifest(f.manifest);
        assert.equal(tools[0].artifacts[0].archivePath, await realpath(path.join(f.root, 'runtime.tar.gz')));
        const result = await publishCatalog({ manifest: f.manifest, dryRun: true });
        assert.equal(result.dryRun, true);
        assert.deepEqual(result.tools[0].targets, ['darwin-arm64']);
        assert.deepEqual(await readdir(f.root), before);
        assert.equal((await readFile(path.join(f.root, 'runtime.tar.gz'))).length, f.descriptor.compressedBytes);
    } finally { globalThis.fetch = originalFetch; }
});

test('Поддерживает сохранённый ключ и отклоняет key внутри публичного payload', async () => {
    const f = await fixture();
    const savedKey = '7428c85e-c645-4f05-b610-6f0029867f93'; // gitleaks:allow — тестовый UUID идемпотентного запроса, не ключ доступа.
    await f.save([{ ...f.tool, publicationKey: savedKey }]);
    assert.equal((await readyManifest(f.manifest))[0].publication.publicationKey, savedKey);
    await f.save([{ ...f.tool, publication: { ...f.tool.publication, publicationKey: savedKey } }]);
    await assert.rejects(readyManifest(f.manifest), /publication без publicationKey/);
});

test('Все инструменты проверяются до HTTP, включая повреждённый второй архив', async () => {
    const f = await fixture();
    const second = { ...f.tool, key: 'second', publication: { ...f.tool.publication, name: 'Second plugin' },
        artifacts: [{ archivePath: 'missing.tar.gz', descriptorPath: 'descriptor.json' }] };
    await f.save([f.tool, second]);
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = () => { requests++; throw new Error('Нельзя публиковать неполный manifest'); };
    try { await assert.rejects(publishCatalog({ manifest: f.manifest, dryRun: false }), /ENOENT/); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(requests, 0);
});

test('Несовпадающие descriptor и публикация не превращаются в устанавливаемую карточку', async () => {
    const f = await fixture();
    await f.save([{ ...f.tool, publication: { ...f.tool.publication, config: { extra: { runtimeArtifacts: [{ ...f.descriptor, sha256: 'b'.repeat(64) }] } } } }]);
    await assert.rejects(readyManifest(f.manifest), /не совпадают/);
    await f.save();
    await writeFile(path.join(f.root, 'runtime.tar.gz'), Buffer.alloc(f.descriptor.compressedBytes));
    await assert.rejects(readyManifest(f.manifest), /SHA-256/);
});

test('Не принимает плавающую ревизию и повтор инструмента', async () => {
    const f = await fixture();
    await f.save([{ ...f.tool, publication: { ...f.tool.publication, revision: 'latest' } }]);
    await assert.rejects(readyManifest(f.manifest), /точную версию/);
    await f.save([f.tool, f.tool]);
    await assert.rejects(readyManifest(f.manifest), /уникальный key/);
});

test('CLI не пересылает сессию удалённому URL и не игнорирует ошибочные аргументы', () => {
    assert.throws(() => parseArguments(['--manifest', 'ready.json', '--base-url', 'https://example.org']), /локальный dev/);
    assert.throws(() => parseArguments(['--manifest', 'ready.json', '--base-url', 'http://localhost:5173/path']), /локальный dev/);
    assert.throws(() => parseArguments(['--manifest', 'ready.json', '--unknown', 'value']), /Параметры/);
    assert.throws(() => parseArguments(['--manifest', 'ready.json', '--dry-run', '--dry-run']), /повторён/);
    assert.equal(parseArguments(['--manifest', 'ready.json', '--dry-run']).dryRun, true);
});

test('Dev-публикация использует собственную сессию и закрывает её после запроса каталога', async () => {
    const f = await fixture();
    await f.save([{ ...f.tool, artifacts: [], publication: { ...f.tool.publication,
        config: { entrypoint: 'index.mjs' }, files: [{ path: 'index.mjs', content: 'export default async () => ({})' }] } }]);
    const originalFetch = globalThis.fetch;
    const previousEnvironment = { SSO_DISABLE: process.env.SSO_DISABLE, NODE_ENV: process.env.NODE_ENV };
    process.env.SSO_DISABLE = 'true'; process.env.NODE_ENV = 'development';
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url, ...init });
        if (url.endsWith('/auth/me')) {
            return init.headers.Cookie ? Response.json({ user: { activeRole: 'Главный админ', userRoles: ['Главный админ'] } })
                : Response.json({ message: 'Unauthorized' }, { status: 401 });
        }
        if (url.endsWith('/auth/login')) { return new Response(null, { status: 302, headers: { Location: 'http://localhost:5173/', 'Set-Cookie': 'bridge_session=private-session; HttpOnly' } }); }
        if (url.endsWith('/api/ai-plugins')) { return Response.json({ id: 'ai-plug-test', name: 'Example plugin', version: 1 }, { status: 201 }); }
        if (url.endsWith('/auth/logout')) { return Response.json({}); }
        throw new Error('Неожиданный маршрут');
    };
    try {
        const result = await publishCatalog({ manifest: f.manifest, baseUrl: 'http://localhost:5173', dryRun: false });
        assert.equal(result.tools[0].id, 'ai-plug-test');
        const publication = requests.find(request => request.url.endsWith('/api/ai-plugins'));
        assert.equal(publication.headers['X-Neurocenter-Request'], '1');
        assert.equal(publication.headers.Cookie, 'bridge_session=private-session');
        assert.equal(publication.redirect, 'manual');
        assert.equal(JSON.parse(publication.body).publicationKey, publicationKey('example-plugin', '1.2.3'));
        assert.equal(requests.at(-1).url, 'http://localhost:5173/auth/logout');
        assert.equal(requests.at(-1).method, 'POST');
    } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
    }
});

test('В production не начинает вход, а внешний SSO-редирект никогда не продолжает', async () => {
    const f = await fixture();
    const originalFetch = globalThis.fetch;
    const previousEnvironment = { SSO_DISABLE: process.env.SSO_DISABLE, NODE_ENV: process.env.NODE_ENV };
    const routes = [];
    globalThis.fetch = async url => {
        routes.push(url);
        return url.endsWith('/auth/me') ? Response.json({}, { status: 401 })
            : new Response(null, { status: 302, headers: { Location: 'https://idp.example.test/authorize', 'Set-Cookie': 'oauth_state=private; HttpOnly' } });
    };
    try {
        process.env.SSO_DISABLE = 'true'; process.env.NODE_ENV = 'production';
        await assert.rejects(publishCatalog({ manifest: f.manifest, baseUrl: 'http://localhost:5173', dryRun: false }), /действующая сессия/);
        assert.deepEqual(routes, ['http://localhost:5173/auth/me']);
        process.env.NODE_ENV = 'development'; routes.length = 0;
        await assert.rejects(publishCatalog({ manifest: f.manifest, baseUrl: 'http://localhost:5173', dryRun: false }), /требует SSO/);
        assert.deepEqual(routes, ['http://localhost:5173/auth/me', 'http://localhost:5173/auth/login']);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
    }
});
