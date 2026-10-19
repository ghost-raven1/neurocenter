import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { builtinRecipes, parsePrepareArguments, prepareCatalog } from '../prepare.mjs';
import { readyManifest } from '../manifest.mjs';
import { validateRecipe } from '../recipe-schema.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); } });
async function fixture() { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-prepare-'))); roots.push(root); return { root, output: path.join(root, 'output') }; }

test('Все встроенные инструменты являются рецептами единого builder с новой ревизией упаковки', () => {
    const recipes = builtinRecipes();
    assert.equal(recipes.length, 7);
    assert.equal(new Set(recipes.map(recipe => recipe.key)).size, 7);
    for (const recipe of recipes) {
        assert.equal(validateRecipe(recipe).source.type, 'prepared');
        assert.match(recipe.revision, /pack\.\d+$/);
    }
    assert.equal(validateRecipe(recipes.find(recipe => recipe.key === 'opencode-rag')).targets.length, 7);
    assert.equal(recipes.find(recipe => recipe.key === 'project-context').revision, '1.0.1-pack.1');
    assert.equal(recipes.find(recipe => recipe.key === 'git-context').revision, '1.0.0-pack.1');
    assert.equal(recipes.find(recipe => recipe.key === 'opencode-rag').revision, '2.4.4-mcp.pack.3');
});

test('Общий dry-run проверяет семь рецептов и не создаёт output или сетевую сессию', async () => {
    const f = await fixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Dry-run обратился к сети'); };
    try {
        const result = await prepareCatalog({ output: f.output, dryRun: true });
        assert.equal(result.dryRun, true);
        assert.equal(result.tools.length, 7);
        assert.ok(result.tools.every(tool => tool.dryRun));
        await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    } finally { globalThis.fetch = originalFetch; }
});

test('Встроенные JS-плагины проходят ту же упаковку и корректные пути общего manifest', async () => {
    const f = await fixture();
    const result = await prepareCatalog({ output: f.output, only: ['project-context', 'git-context'], targets: ['darwin-arm64'] });
    assert.equal(result.tools.length, 2);
    const tools = await readyManifest(path.join(f.output, 'ready.json'));
    for (const tool of tools) {
        assert.equal(tool.artifacts.length, 1);
        assert.ok(tool.artifacts[0].archivePath.startsWith(path.join(f.output, tool.key) + path.sep));
        assert.match(tool.publication.config.extra.runtimeArtifacts[0].entrypoint, /context\.mjs$/);
        assert.equal(JSON.parse(await fs.readFile(path.join(f.output, tool.key, 'provenance.json'), 'utf8')).runtimeChecked, false);
    }
});

test('Неизвестные и несовместимые фильтры отклоняются до создания общей папки', async () => {
    const f = await fixture();
    for (const options of [{ only: ['missing'] }, { only: [] }, { only: ['memory', 'memory'] }, { targets: ['missing'] }, { only: ['opencode-rag'], targets: ['darwin-x64'] }]) {
        await assert.rejects(prepareCatalog({ output: f.output, ...options }));
        await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    }
    assert.deepEqual(parsePrepareArguments(['--output', 'out', '--only', 'memory,filesystem', '--targets', 'darwin-arm64', '--dry-run']),
        { output: 'out', only: ['memory', 'filesystem'], targets: ['darwin-arm64'], dryRun: true });
    assert.throws(() => parsePrepareArguments(['--output', 'out', '--only', 'memory', '--only', 'memory']), /повторён/);
});
