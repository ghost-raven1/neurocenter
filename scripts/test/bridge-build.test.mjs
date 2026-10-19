import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBridgeBuild } from '../bridge-build-integrity.mjs';

const bridge = fileURLToPath(new URL('../../mcp/neurocenter-asset-sync/', import.meta.url));
const shared = fileURLToPath(new URL('../../services/shared/runtime-artifacts.cjs', import.meta.url));
const ragContract = fileURLToPath(new URL('../../services/shared/rag-index-contract.cjs', import.meta.url));
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(source) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-build-')); roots.push(workspace);
    const root = path.join(workspace, 'mcp/neurocenter-asset-sync');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(workspace, 'services/shared'), { recursive: true });
    await fs.copyFile(shared, path.join(workspace, 'services/shared/runtime-artifacts.cjs'));
    await fs.copyFile(ragContract, path.join(workspace, 'services/shared/rag-index-contract.cjs'));
    for (const name of ['src', 'scripts', 'dist']) await fs.mkdir(path.join(root, name));
    await fs.symlink(path.join(bridge, 'node_modules'), path.join(root, 'node_modules'));
    await fs.copyFile(path.join(bridge, 'scripts/build.mjs'), path.join(root, 'scripts/build.mjs'));
    await fs.writeFile(path.join(root, 'package.json'), '{"version":"0.2.0","type":"module"}');
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","outDir":"dist","rootDir":"src","skipLibCheck":true},"include":["src"]}');
    await fs.writeFile(path.join(root, 'src/index.ts'), source);
    await fs.writeFile(path.join(root, 'dist/removed-tool.js'), 'Старая реализация');
    return { root, run: () => spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { encoding: 'utf8' }) };
}
test('Чистая сборка убирает удалённый инструмент и фиксирует отпечаток runtime', async () => {
    const f = await fixture('export const value: number = 1;'); const result = f.run(); assert.equal(result.status, 0, result.stderr);
    await assert.rejects(fs.access(path.join(f.root, 'dist/removed-tool.js')), { code: 'ENOENT' });
    const build = JSON.parse(await fs.readFile(path.join(f.root, 'dist/build.json'), 'utf8'));
    assert.match(build.buildId, /^[a-f0-9]{64}$/);
    assert.equal(await fs.readFile(path.join(f.root, 'dist/shared/runtime-artifacts.cjs'), 'utf8'), await fs.readFile(shared, 'utf8'));
    assert.equal(await fs.readFile(path.join(f.root, 'dist/shared/rag-index-contract.cjs'), 'utf8'), await fs.readFile(ragContract, 'utf8'));
});
test('Ошибка компиляции сохраняет предыдущую рабочую сборку', async () => {
    const f = await fixture('export const value: number = "ошибка";'); assert.notEqual(f.run().status, 0);
    assert.equal(await fs.readFile(path.join(f.root, 'dist/removed-tool.js'), 'utf8'), 'Старая реализация');
    assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.bridge-build-')));
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
