import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildRecipe } from '../build.mjs';
import { validateRecipe } from '../recipe-schema.mjs';
import { downloadRepositoryArchive } from '../repository-source.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';
import fixture from '../../test/runtime-artifact-fixture.cjs';

const commit = 'a'.repeat(40);
const source = { type: 'repository', url: 'https://github.com/fixture/demo', commit, entrypoint: 'src/index.ts' };
const recipe = { schemaVersion: 1, key: 'repository-fixture', name: 'Тестовый репозиторий', kind: 'plugin', revision: 'git-' + commit,
    description: 'Сборка закреплённого репозитория', source, targets: ['darwin-arm64'] };
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-repository-')).then(value => fs.realpath(value));
const archive = files => fixture.artifactFixture(files.map(file => ({ ...file, path: `demo-${commit}/${file.path}` }))).archive;

test('Репозиторий требует полный commit и безопасную точку входа; dry-run не скачивает и не пишет', async () => {
    const root = await temporary(), previous = globalThis.fetch;
    try {
        const normalized = validateRecipe({ ...recipe, source: { ...source, url: 'https://github.com/Fixture/Demo.git', commit: commit.toUpperCase() } });
        assert.deepEqual(normalized.source, source);
        for (const change of [{ commit: 'main' }, { url: 'https://git.example/demo' }, { entrypoint: '../outside.ts' }, { subdirectory: '.git' }, { hooks: [] }]) {
            assert.throws(() => validateRecipe({ ...recipe, source: { ...source, ...change } }));
        }
        globalThis.fetch = () => { throw new Error('Dry-run не должен обращаться к сети'); };
        const output = path.join(root, 'output');
        const result = await buildRecipe({ recipe, recipePath: path.join(root, 'recipe.json'), output, dryRun: true });
        assert.equal(result.dryRun, true);
        await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    } finally { globalThis.fetch = previous; await fs.rm(root, { recursive: true, force: true }); }
});

test('Архив скачивается один раз по codeload commit, кэш проверяется SHA и не маскирует подмену', async () => {
    const root = await temporary();
    try {
        const bytes = archive([{ path: 'src/index.ts', content: 'export default 1;' }]);
        let requests = 0;
        const fetch = async (url, options) => {
            requests++;
            assert.equal(url, `https://codeload.github.com/fixture/demo/tar.gz/${commit}`);
            assert.equal(options.redirect, 'error');
            assert.equal(options.headers.Authorization, undefined);
            return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
        };
        const [first, concurrent] = await Promise.all([downloadRepositoryArchive(source, root, { fetch }), downloadRepositoryArchive(source, root, { fetch })]);
        assert.deepEqual(first, concurrent);
        assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(await downloadRepositoryArchive(source, root, { fetch }), first);
        assert.equal(requests, 1);
        await fs.chmod(first.archivePath, 0o600); await fs.appendFile(first.archivePath, 'tampered');
        await assert.rejects(downloadRepositoryArchive(source, root, { fetch }), /повреждён/);
        assert.equal(requests, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Переполнение, обрыв и редирект загрузки не оставляют partial или готовый архив', async () => {
    for (const response of [
        () => new Response('x', { headers: { 'content-length': String(256 * 1024 ** 2 + 1) } }),
        () => new Response('x', { headers: { 'content-length': '2' } }),
        () => new Response(null, { status: 302, headers: { location: 'https://example.test/steal' } }),
    ]) {
        const root = await temporary();
        try {
            await assert.rejects(downloadRepositoryArchive(source, root, { fetch: async () => response() }));
            assert.deepEqual(await fs.readdir(root), []);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    }
});

test('Один repository pipeline собирает две платформы из monorepo, сохраняет commit, лицензии и main guard', async () => {
    const root = await temporary(), previous = globalThis.fetch;
    try {
        const files = [
            { path: 'LICENSE', content: 'Root license' },
            { path: 'packages/tool/NOTICE.md', content: 'Package notice' },
            { path: 'packages/tool/package.json', content: '{"type":"module"}' },
            { path: 'packages/tool/src/index.ts', content: "import {pathToFileURL} from 'node:url'; export default async function plugin(input:{name:string}){return {name:input.name}}; if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log('REPOSITORY_MAIN');" },
            ...Array.from({ length: 105 }, (_, index) => ({ path: `packages/tool/docs/${index}.md`, content: 'Documentation' })),
        ];
        const bytes = archive(files); let requests = 0;
        globalThis.fetch = async () => { requests++; return new Response(bytes); };
        const output = path.join(root, 'output');
        const result = await buildRecipe({ recipe: { ...recipe, source: { ...source, subdirectory: 'packages/tool' }, targets: ['darwin-arm64', 'linux-x64-glibc'] }, recipePath: path.join(root, 'recipe.json'), output });
        assert.equal(result.runtimeChecked, false); assert.equal(requests, 1);
        const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
        assert.equal(manifest.tools[0].publication.origin, source.url);
        assert.equal(manifest.tools[0].artifacts.length, 2);
        const provenance = JSON.parse(await fs.readFile(path.join(output, 'provenance.json'), 'utf8'));
        assert.equal(provenance.sources[0].upstream.commit, commit);
        assert.equal(provenance.sources[0].upstream.archiveSha256, createHash('sha256').update(bytes).digest('hex'));
        const artifact = manifest.tools[0].artifacts[0];
        const descriptor = JSON.parse(await fs.readFile(path.join(output, artifact.descriptorPath), 'utf8'));
        const unpacked = path.join(root, 'unpacked');
        await runtime.inspectRuntimeArchive(path.join(output, artifact.archivePath), descriptor, { destination: unpacked });
        const entry = path.join(unpacked, descriptor.entrypoint);
        assert.equal(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim(), 'REPOSITORY_MAIN');
        const { default: plugin } = await import(pathToFileURL(entry)); assert.deepEqual(await plugin({ name: 'Проверка' }), { name: 'Проверка' });
        assert.equal(await fs.readFile(path.join(unpacked, 'upstream-licenses/root/LICENSE'), 'utf8'), 'Root license');
        assert.equal(await fs.readFile(path.join(unpacked, 'upstream-licenses/package/NOTICE.md'), 'utf8'), 'Package notice');
        assert.equal(JSON.parse(await fs.readFile(path.join(unpacked, 'repository.json'), 'utf8')).commit, commit);
        assert.deepEqual((await fs.readdir(output)).filter(name => name.startsWith('.')), []);
    } finally { globalThis.fetch = previous; await fs.rm(root, { recursive: true, force: true }); }
});

test('Ссылки, traversal и чужой корень TAR блокируются до компиляции и готового manifest', async () => {
    const previous = globalThis.fetch;
    try {
        for (const bad of [
            { path: `demo-${commit}/link`, type: '2', link: '../outside' },
            { path: `demo-${commit}/hard`, type: '1', link: `demo-${commit}/src/index.ts` },
            { path: `demo-${commit}/../outside`, content: 'bad' },
            { path: `other-${commit}/index.ts`, content: 'bad' },
        ]) {
            const root = await temporary();
            try {
                const bytes = fixture.artifactFixture([{ path: `demo-${commit}/src/index.ts`, content: 'export default 1;' }, bad]).archive;
                globalThis.fetch = async () => new Response(bytes);
                const output = path.join(root, 'output');
                await assert.rejects(buildRecipe({ recipe, recipePath: path.join(root, 'recipe.json'), output }), /Архив репозитория/);
                assert.deepEqual(await fs.readdir(output), []);
                assert.deepEqual(await fs.readdir(root), ['output']);
            } finally { await fs.rm(root, { recursive: true, force: true }); }
        }
    } finally { globalThis.fetch = previous; }
});

test('Репозиторий с рецептом native использует общий адаптер, сохраняет SHA и только заявленные платформы', async () => {
    const root = await temporary(), previous = globalThis.fetch;
    try {
        const runtimeSource = { type: 'runtime', adapter: 'go', assets: { 'darwin-arm64': { app: { directory: 'payload', entrypoint: 'server' } } } };
        const manifestBytes = JSON.stringify({ schemaVersion: 1, name: 'Готовый MCP', source: runtimeSource });
        const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
        const bytes = archive([{ path: 'neurocenter.tool.json', content: manifestBytes }, { path: 'payload/server', content: 'prepared native program' }, { path: 'LICENSE', content: 'Native license' }]);
        globalThis.fetch = async () => new Response(bytes);
        const pinned = { ...source, entrypoint: 'neurocenter.tool.json', runtimeSource, manifestSha256 };
        const input = { ...recipe, kind: 'mcp', source: pinned };
        assert.throws(() => validateRecipe({ ...input, kind: 'plugin' }), /MCP|mcp/);
        assert.throws(() => validateRecipe({ ...input, targets: ['win32-x64'] }), /платформ/);
        const result = await buildRecipe({ recipe: input, recipePath: path.join(root, 'recipe.json'), output: path.join(root, 'output') });
        const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
        assert.equal(manifest.tools[0].publication.kind, 'mcp');
        assert.doesNotMatch(manifest.tools[0].publication.compatibility, /JavaScript/);
        assert.equal(manifest.tools[0].artifacts.length, 1);
        const artifact = manifest.tools[0].artifacts[0];
        const descriptor = JSON.parse(await fs.readFile(path.join(root, 'output', artifact.descriptorPath), 'utf8'));
        assert.equal(descriptor.entrypoint, 'app/server'); assert.equal(descriptor.executable, true);
        const unpacked = path.join(root, 'unpacked');
        await runtime.inspectRuntimeArchive(path.join(root, 'output', artifact.archivePath), descriptor, { destination: unpacked });
        const origin = JSON.parse(await fs.readFile(path.join(unpacked, 'repository.json'), 'utf8'));
        assert.equal(origin.manifestSha256, manifestSha256); assert.equal(origin.adapter, 'go');
        assert.equal(await fs.readFile(path.join(unpacked, 'app/server'), 'utf8'), 'prepared native program');
        assert.equal(await fs.readFile(path.join(unpacked, 'upstream-licenses/root/LICENSE'), 'utf8'), 'Native license');
        await assert.rejects(buildRecipe({ recipe: { ...input, source: { ...pinned, manifestSha256: '0'.repeat(64) } },
            recipePath: path.join(root, 'recipe.json'), output: path.join(root, 'tampered') }), /закреплённым SHA/);
        await assert.rejects(fs.stat(path.join(root, 'tampered/ready.json')), { code: 'ENOENT' });
        await assert.rejects(buildRecipe({ recipe: { ...input, source: { ...pinned, runtimeSource: { ...runtimeSource, adapter: 'rust' } } },
            recipePath: path.join(root, 'recipe.json'), output: path.join(root, 'changed') }), /Адаптер поставки изменился/);
    } finally { globalThis.fetch = previous; await fs.rm(root, { recursive: true, force: true }); }
});
