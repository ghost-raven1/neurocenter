import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareRepository } from '../repository-source.mjs';
import { extractRelease } from '../source-adapters.mjs';
import { applyFetchCompatibility } from '../recipes/fetch-mcp.mjs';
import fixture from '../../test/runtime-artifact-fixture.cjs';

const source = { type: 'repository', url: 'https://github.com/zcaceres/fetch-mcp',
    commit: '1ddb1a59cb09a2d38e759f2d7a97829680cbe514', entrypoint: 'src/index.ts' };
const original = await fs.readFile(new URL('./fixtures/fetch-mcp/index.ts', import.meta.url), 'utf8');
const sourceSha256 = '72a37b4a3d371948d0075184b299fc5d62557ee74f27195f5c57d4214811b4be';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function prepared(content, inspect) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-fetch-'));
    const previous = globalThis.fetch;
    try {
        const bytes = fixture.artifactFixture([{ path: 'fetch-mcp-' + source.commit + '/src/index.ts', content }]).archive;
        globalThis.fetch = async () => new Response(bytes);
        const directory = path.join(root, 'output');
        await fs.mkdir(directory);
        return await inspect({ root, directory, prepare: prepareProject => prepareRepository({ kind: 'mcp', source },
            { directory, recipeDirectory: root, cacheDirectory: path.join(root, 'cache'), target: 'darwin-arm64' },
            { extractRelease, prepareProject }) });
    } finally { globalThis.fetch = previous; await fs.rm(root, { recursive: true, force: true }); }
}

test('Закреплённый Fetch проходит repository pipeline с честным tools-only и provenance исправления', async () => {
    assert.equal(hash(original), sourceSha256);
    await prepared(original, async ({ directory, prepare }) => {
        let patched;
        const result = await prepare(async (projectRecipe, context) => {
            patched = await fs.readFile(path.join(context.recipeDirectory, projectRecipe.source.directory, source.entrypoint), 'utf8');
            return { entrypoint: 'entrypoint.mjs' };
        });
        assert.equal(patched, original.replace('      resources: {},\n', ''));
        const [patch] = result.upstream.compatibilityPatches;
        assert.equal(patch.id, 'fetch-tools-only-v1');
        assert.equal(patch.path, source.entrypoint);
        assert.equal(patch.sourceSha256, sourceSha256);
        assert.equal(patch.patchedSha256, hash(patched));
        const repository = JSON.parse(await fs.readFile(path.join(directory, 'repository.json'), 'utf8'));
        assert.deepEqual(repository.compatibilityPatches, [patch]);
    });
});

test('Изменённый исходник известного Fetch отклоняется до компиляции и публикации provenance', async () => {
    await prepared(original + '\n// changed\n', async ({ directory, prepare }) => {
        let compiled = false;
        await assert.rejects(prepare(async () => { compiled = true; return {}; }), /Fetch.*SHA-256/);
        assert.equal(compiled, false);
        assert.deepEqual(await fs.readdir(directory), []);
    });
});

test('Другой репозиторий, commit, entrypoint и адаптер не изменяются известным исправлением', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-fetch-guard-'));
    try {
        await fs.mkdir(path.join(root, 'src'));
        const filename = path.join(root, 'src/index.ts');
        await fs.writeFile(filename, original);
        for (const change of [{ url: 'https://github.com/other/fetch-mcp' }, { commit: 'a'.repeat(40) },
            { entrypoint: 'other.ts' }, { subdirectory: 'pkg' }, { runtimeSource: {} }]) {
            assert.equal(await applyFetchCompatibility({ ...source, ...change }, root), undefined);
            assert.equal(await fs.readFile(filename, 'utf8'), original);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Повторное применение к уже изменённому Fetch отклоняется проверкой исходного SHA', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-fetch-repeat-'));
    try {
        await fs.mkdir(path.join(root, 'src'));
        const filename = path.join(root, 'src/index.ts');
        await fs.writeFile(filename, original);
        await applyFetchCompatibility(source, root);
        const patched = await fs.readFile(filename);
        await assert.rejects(applyFetchCompatibility(source, root), /Fetch.*SHA-256/);
        assert.deepEqual(await fs.readFile(filename), patched);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
