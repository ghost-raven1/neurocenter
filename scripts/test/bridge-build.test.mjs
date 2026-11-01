import { BRIDGE_SHARED_RUNTIME_FILES } from '../../mcp/neurocenter-asset-sync/scripts/runtime-shared-files.mjs';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { verifyBridgeBuild } from '../bridge-build-integrity.mjs';

const bridge = fileURLToPath(new URL('../../mcp/neurocenter-asset-sync/', import.meta.url));
const { RUNTIME_USE_ENTRYPOINTS } = createRequire(import.meta.url)('../../services/shared/bridge-update-cleanup.cjs');
const namedExports = {
    'dist/bridge/connect.js': ['startWorker', 'connectBridge', 'watchPair'],
    'dist/features/opencode-providers/authorization.js': ['authorizeManagedProvider'],
    'dist/features/opencode-providers/ollama-sdk.js': ['createOllama'],
};
const roots = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(source) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-build-'));
    roots.push(workspace);
    const root = path.join(workspace, 'mcp/neurocenter-asset-sync');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(workspace, 'services/shared'), { recursive: true });
    for (const name of BRIDGE_SHARED_RUNTIME_FILES)
        await fs.copyFile(
            path.join(bridge, '../../services/shared', name),
            path.join(workspace, 'services/shared', name),
        );
    for (const name of ['src', 'scripts', 'dist']) await fs.mkdir(path.join(root, name));
    await fs.symlink(path.join(bridge, 'node_modules'), path.join(root, 'node_modules'));
    await fs.cp(path.join(bridge, 'vendor'), path.join(root, 'vendor'), { recursive: true });
    await fs.copyFile(path.join(bridge, 'package-lock.json'), path.join(root, 'package-lock.json'));
    for (const name of ['build.mjs', 'runtime-shared-files.mjs'])
        await fs.copyFile(path.join(bridge, 'scripts', name), path.join(root, 'scripts', name));
    await fs.copyFile(
        path.join(bridge, 'scripts/runtime-bootstraps.mjs'),
        path.join(root, 'scripts/runtime-bootstraps.mjs'),
    );
    await fs.writeFile(path.join(root, 'package.json'), '{"version":"0.2.0","type":"module"}');
    await fs.mkdir(path.join(root, 'vendor/ollama-runtime'), { recursive: true });
    for (const name of ['package.json', 'index.js'])
        await fs.copyFile(
            path.join(bridge, 'vendor/ollama-runtime', name),
            path.join(root, 'vendor/ollama-runtime', name),
        );
    await fs.copyFile(path.join(bridge, 'package-lock.json'), path.join(root, 'package-lock.json'));
    await fs.writeFile(
        path.join(root, 'tsconfig.json'),
        '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","outDir":"dist","rootDir":"src","skipLibCheck":true},"include":["src"]}',
    );
    await fs.writeFile(path.join(root, 'src/index.ts'), source);
    // Exercise every real public wrapper, including the three retained SDK exports.
    for (const entry of RUNTIME_USE_ENTRYPOINTS.filter((value) => value !== 'dist/index.js')) {
        const file = path.join(root, entry.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
            file,
            (namedExports[entry] ?? []).map((name) => `export const ${name}=()=>${JSON.stringify(name)};`).join('\n') ||
                'export {};',
        );
    }
    await fs.writeFile(path.join(root, 'dist/removed-tool.js'), 'Старая реализация');
    return {
        root,
        run: () => spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { encoding: 'utf8' }),
    };
}
test('Чистая сборка убирает удалённый инструмент и фиксирует отпечаток runtime', async () => {
    const f = await fixture('export const value: number = 1;');
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(fs.access(path.join(f.root, 'dist/removed-tool.js')), { code: 'ENOENT' });
    const build = JSON.parse(await fs.readFile(path.join(f.root, 'dist/build.json'), 'utf8'));
    assert.match(build.buildId, /^[a-f0-9]{64}$/);
    for (const name of BRIDGE_SHARED_RUNTIME_FILES)
        assert.equal(
            await fs.readFile(path.join(f.root, 'dist/shared', name), 'utf8'),
            await fs.readFile(new URL('../../services/shared/' + name, import.meta.url), 'utf8'),
        );
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'dist/runtime-use.json'), 'utf8')), {
        schemaVersion: 1,
        entrypoints: RUNTIME_USE_ENTRYPOINTS,
    });
    const modules = RUNTIME_USE_ENTRYPOINTS.map((entry) => ({
        entry,
        url: pathToFileURL(path.join(f.root, entry)).href,
        names: namedExports[entry] ?? [],
    }));
    const loaded = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `const results=[];for(const item of ${JSON.stringify(modules)}){const m=await import(item.url);results.push([item.entry,item.names.map(name=>m[name]())]);}console.log(JSON.stringify(results));`,
        ],
        { encoding: 'utf8' },
    );
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.deepEqual(
        JSON.parse(loaded.stdout),
        modules.map((item) => [item.entry, item.names]),
    );
});
test('Ошибка компиляции сохраняет предыдущую рабочую сборку', async () => {
    const f = await fixture('export const value: number = "ошибка";');
    assert.notEqual(f.run().status, 0);
    assert.equal(await fs.readFile(path.join(f.root, 'dist/removed-tool.js'), 'utf8'), 'Старая реализация');
    assert.ok(!(await fs.readdir(f.root)).some((name) => name.startsWith('.bridge-build-')));
});

test('Упаковка отклоняет прежний dist под новой версией и изменённый файл после сборки', async () => {
    const f = await fixture('export const value: number = 1;');
    assert.equal(f.run().status, 0);
    const directory = path.join(f.root, 'dist');
    assert.equal((await verifyBridgeBuild(directory, '0.2.0')).version, '0.2.0');
    await assert.rejects(verifyBridgeBuild(directory, '0.2.1'), /Версия сборки/);
    await fs.appendFile(path.join(directory, 'index.js'), '\n// Изменение после сборки\n');
    await assert.rejects(verifyBridgeBuild(directory, '0.2.0'), /Отпечаток сборки/);
});
