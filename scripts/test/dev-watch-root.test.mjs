import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {backendSelection} from '../workspace/dev-watch-plan.mjs';

const source = fileURLToPath(new URL('../dev.mjs', import.meta.url));
const freeze = new URL('../workspace/dev-watch-files.mjs', import.meta.url).href;

/** Exercise the CLI's computed root against the real generation freezer without launching services. */
test('dev CLI supplies a canonical checkout root to the initial watch generation', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter watch корень ')));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const script = path.join(root, 'scripts/dev.mjs');
    await fs.mkdir(path.dirname(script), {recursive: true});
    await fs.copyFile(source, script);
    await fs.mkdir(path.join(root, 'node_modules'));
    for (const [, folder, entry] of backendSelection) {
        await fs.mkdir(path.join(root, folder, 'node_modules'), {recursive: true});
        await fs.mkdir(path.join(root, folder, 'dist'), {recursive: true});
        await fs.writeFile(path.join(root, folder, 'dist', entry), '// already-built fixture\n');
    }
    for (const args of [['init', '-q'], ['add', 'scripts/dev.mjs'], ['-c', 'user.name=Watch fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'CLI fixture']]) {
        const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
        assert.equal(result.status, 0, result.stderr);
    }
    const probe = path.join(root, '.run/probe.mjs');
    await fs.mkdir(path.dirname(probe));
    await fs.writeFile(probe, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import {registerHooks} from 'node:module';
        import {initialWatchGeneration} from ${JSON.stringify(freeze)};
        const entry = ${JSON.stringify(pathToFileURL(script).href)};
        const original = ${JSON.stringify(pathToFileURL(source).href)};
        registerHooks({
            resolve(specifier, context, next) {
                return context.parentURL === entry && specifier.startsWith('./')
                    ? next(new URL(specifier, original).href, context) : next(specifier, context);
            },
            load(url, context, next) {
                const loaded = next(url, context);
                return url === entry ? {...loaded, source: loaded.source + '\\nexport {root as fixtureRoot};'} : loaded;
            },
        });
        process.argv = [process.execPath, ${JSON.stringify(script)}, '--help'];
        const {fixtureRoot} = await import(entry);
        const generation = await initialWatchGeneration(fixtureRoot);
        try {
            assert.equal(fixtureRoot, await fs.realpath(${JSON.stringify(root)}));
            await fs.access(generation.repository + '/services/catalog-service/dist/main.js');
        } finally { await fs.rm(generation.folder, {recursive: true, force: true}); }
    `);
    const result = spawnSync(process.execPath, [probe], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: {PATH: process.env.PATH, NODE_BIN: process.execPath, NO_COLOR: '1', TERM: 'dumb'},
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
