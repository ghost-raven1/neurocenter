import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { exportCatalogRelease, parseReleaseArguments } from '../release.mjs';

const { artifactFixture } = createRequire(import.meta.url)('../../test/runtime-artifact-fixture.cjs');
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); } });
async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-release-')));
    roots.push(root);
    const { archive, descriptor } = artifactFixture();
    await fs.writeFile(path.join(root, 'runtime.tar.gz'), archive);
    await fs.writeFile(path.join(root, 'descriptor.json'), JSON.stringify(descriptor));
    const tool = { key: 'filesystem', publicationKey: '7428c85e-c645-4f05-b610-6f0029867f93', // gitleaks:allow — тестовый ключ идемпотентности.
        publication: { name: 'MCP Filesystem', kind: 'mcp', description: 'Проверочный комплект', origin: 'neurocenter:recipe/filesystem',
            tags: ['Файлы'], revision: '1.0.0-pack.1', config: { transport: 'stdio', command: 'node', entrypoint: descriptor.entrypoint,
                extra: { runtimeArtifacts: [descriptor] } }, files: [] },
        artifacts: [{ archivePath: 'runtime.tar.gz', descriptorPath: 'descriptor.json' }] };
    const manifest = path.join(root, 'ready.json'), output = path.join(root, 'output');
    const save = tools => fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, tools }));
    await save([tool]);
    return { root, manifest, output, tool, archive, descriptor, save };
}
const options = f => ({ manifest: f.manifest, output: f.output, release: 'catalog-2026-10-19.1' });

test('Экспорт сохраняет публичную публикацию и переносит архив без локальных путей и ключей', async () => {
    const f = await fixture();
    const result = await exportCatalogRelease(options(f));
    const bytes = await fs.readFile(result.manifest, 'utf8'), manifest = JSON.parse(bytes);
    assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'release', 'tools']);
    assert.deepEqual(manifest.tools[0].publication, f.tool.publication);
    assert.deepEqual(manifest.tools[0].artifacts, [{ descriptor: f.descriptor,
        url: `https://github.com/ghost-raven1/neurocenter/releases/download/catalog-2026-10-19.1/${f.descriptor.sha256}.tar.gz` }]);
    assert.deepEqual(manifest.tools[0].legacyPackages, ['@modelcontextprotocol/server-filesystem']);
    assert.ok(manifest.tools[0].legacyOrigins.includes('https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem'));
    assert.equal(new Set(manifest.tools[0].legacyOrigins).size, manifest.tools[0].legacyOrigins.length);
    assert.equal(bytes.includes('publicationKey'), false); assert.equal(bytes.includes(f.root), false);
    assert.deepEqual(await fs.readFile(path.join(f.output, `${f.descriptor.sha256}.tar.gz`)), f.archive);
    assert.equal((await fs.stat(path.join(f.output, `${f.descriptor.sha256}.tar.gz`))).nlink, 1);
});

test('Общий SHA-256 копируется один раз для нескольких инструментов', async () => {
    const f = await fixture();
    const second = { ...f.tool, key: 'memory', publication: { ...f.tool.publication, name: 'MCP Memory', origin: 'custom:memory' } };
    await f.save([f.tool, second]);
    const result = await exportCatalogRelease(options(f));
    assert.equal(result.archives, 1); assert.equal(result.tools.length, 2);
    assert.deepEqual((await fs.readdir(f.output)).sort(), [`${f.descriptor.sha256}.tar.gz`, 'catalog-release.json'].sort());
    assert.equal(result.tools[1].legacyOrigins[0], 'custom:memory');
});

test('Dry-run полностью проверяет manifest и архивы без сетевых запросов или создания папок', async () => {
    const f = await fixture(), before = await fs.readdir(f.root), originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Экспорт не должен обращаться к сети'); };
    try {
        const result = await exportCatalogRelease({ ...options(f), dryRun: true });
        assert.equal(result.dryRun, true); assert.equal(result.archives, 1);
        assert.deepEqual(await fs.readdir(f.root), before);
        await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    } finally { globalThis.fetch = originalFetch; }
});

test('Повреждённый второй архив отклоняется до создания output и копирования первого', async () => {
    const f = await fixture();
    await f.save([f.tool, { ...f.tool, key: 'second', publication: { ...f.tool.publication, name: 'Второй' },
        artifacts: [{ archivePath: 'missing.tar.gz', descriptorPath: 'descriptor.json' }] }]);
    await assert.rejects(exportCatalogRelease(options(f)), /ENOENT/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
});

test('Повреждённые байты не проходят экспорт даже в dry-run', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'runtime.tar.gz'), Buffer.alloc(f.archive.length));
    await assert.rejects(exportCatalogRelease({ ...options(f), dryRun: true }), /SHA-256/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
});

test('Непустая папка и ссылка output не перезаписываются', async () => {
    const f = await fixture();
    await fs.mkdir(f.output); await fs.writeFile(path.join(f.output, 'keep.txt'), 'Сохранить');
    await assert.rejects(exportCatalogRelease(options(f)), /новой или пустой/);
    assert.equal(await fs.readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'Сохранить');
    const linked = path.join(f.root, 'link'); await fs.symlink(f.output, linked);
    await assert.rejects(exportCatalogRelease({ ...options(f), output: linked }), /без ссылок/);
});

test('Неизвестный инструмент сохраняет только собственный origin без предположений о npm', async () => {
    const f = await fixture();
    await f.save([{ ...f.tool, key: 'custom-plugin', publication: { ...f.tool.publication, origin: 'https://example.test/tool' } }]);
    const result = await exportCatalogRelease({ ...options(f), dryRun: true });
    assert.deepEqual(result.tools[0].legacyOrigins, ['https://example.test/tool']);
    assert.equal(Object.hasOwn(result.tools[0], 'legacyPackages'), false);
});

test('Плавающая версия, traversal и некорректные параметры отклоняются', async () => {
    const f = await fixture();
    for (const release of ['latest', 'main', '../escape', 'release with space', 'x'.repeat(65), '']) {
        await assert.rejects(exportCatalogRelease({ ...options(f), release }), /закреплённый release/);
    }
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    assert.deepEqual(parseReleaseArguments(['--manifest', 'ready.json', '--release', 'catalog-1', '--output', 'out', '--dry-run']),
        { manifest: 'ready.json', release: 'catalog-1', output: 'out', dryRun: true });
    assert.throws(() => parseReleaseArguments(['--manifest', 'ready.json']), /Укажите/);
    assert.throws(() => parseReleaseArguments(['--manifest', 'ready.json', '--release', 'one', '--release', 'two']), /повторён/);
    assert.throws(() => parseReleaseArguments(['--help']), /Параметры/);
});
