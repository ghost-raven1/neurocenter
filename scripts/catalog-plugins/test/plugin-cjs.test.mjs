import {readyManifest} from '../manifest.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildRecipe } from '../build.mjs';
import { packRuntime } from '../pack.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';

const factory = `module.exports=async input=>({'experimental.chat.system.transform':async(_request,output)=>output.system.push(input.directory)});`;
async function built(type, inspect, { kind = 'plugin', filename = 'plugin.cjs', content = factory, extra = {} } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-cjs-package-'));
    const previousNpm = process.env.NPM_CLI_JS;
    try {
        const directory = path.join(root, 'source');
        await fs.mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
        await fs.writeFile(path.join(directory, filename), content);
        for (const [name, text] of Object.entries(extra)) await fs.writeFile(path.join(directory, name), text);
        let source = { type, directory: 'source', entrypoint: filename }, asset;
        if (type === 'npm') {
            const cli = path.join(root, 'npm-fixture.mjs');
            await fs.writeFile(cli, `import fs from 'node:fs/promises';import path from 'node:path';
const args=process.argv.slice(2),directory=args[args.indexOf('--prefix')+1],base=path.join(directory,'node_modules/fixture-cjs-plugin');
await fs.mkdir(base,{recursive:true});await fs.writeFile(path.join(base,'package.json'),JSON.stringify({name:'fixture-cjs-plugin',version:'1.0.0',type:'commonjs'}));
await fs.writeFile(path.join(base,'plugin.js'),${JSON.stringify(factory)});await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));`);
            process.env.NPM_CLI_JS = cli;
            source = { type, package: 'fixture-cjs-plugin', version: '1.0.0', entrypoint: 'plugin.js' };
        }
        if (type === 'release') {
            const archive = path.join(root, 'input.tar.gz');
            const descriptor = await packRuntime({ directory, archivePath: archive, target: 'darwin-arm64', entrypoint: filename });
            asset = { url: 'https://example.com/plugin.tar.gz', sha256: descriptor.sha256, format: 'tar.gz', entrypoint: filename };
            source = { type, assets: { 'darwin-arm64': asset } };
        }
        const recipe = { schemaVersion: 1, key: 'cjs-plugin', name: 'CJS plugin', description: 'Проверка совместимости CommonJS', kind, revision: 'cjs-compat.1', source, targets: ['darwin-arm64'] };
        const output = path.join(root, 'output'); let seeded = false;
        const result = await buildRecipe({ recipe, recipePath: path.join(root, 'recipe.json'), output, onProgress: async () => {
            if (!asset || seeded) return; seeded = true;
            const cache = path.join(output, '.source-cache/runtime'); await fs.mkdir(cache, { recursive: true });
            const bytes = await fs.readFile(path.join(root, 'input.tar.gz'));
            await fs.writeFile(path.join(cache, asset.sha256), bytes, { flag: 'wx', mode: 0o400 });
            await fs.writeFile(path.join(cache, asset.sha256) + '.json', JSON.stringify({ schemaVersion: 1, url: asset.url, sha256: asset.sha256, compressedBytes: bytes.length }), { flag: 'wx' });
        } });
        const [built]=await readyManifest(result.manifest);const manifest={tools:[built]};
        const artifact = manifest.tools[0].artifacts[0];
        const descriptor = artifact.descriptor;
        const unpacked = path.join(root, 'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath, descriptor, { destination: unpacked });
        const provenance = JSON.parse(await fs.readFile(path.join(output, 'provenance.json'), 'utf8'));
        await inspect({ root, output, unpacked, descriptor, provenance });
    } finally {
        if (previousNpm === undefined) delete process.env.NPM_CLI_JS; else process.env.NPM_CLI_JS = previousNpm;
        await fs.rm(root, { recursive: true, force: true });
    }
}

for (const type of ['files', 'project', 'release']) test(`${type}: общий builder даёт CommonJS plugin чистый ESM default и настоящий hook`, async () => {
    await built(type, async ({ unpacked, descriptor, provenance }) => {
        assert.match(descriptor.entrypoint, /\.cjs\.mjs$/);
        const mod = await import(pathToFileURL(path.join(unpacked, descriptor.entrypoint)).href);
        assert.deepEqual(Object.keys(mod), ['default']);
        const hooks = await mod.default({ directory: 'мой проект' }); const output = { system: [] };
        await hooks['experimental.chat.system.transform']({}, output);
        assert.deepEqual(output.system, ['мой проект']);
        assert.equal(provenance.sources[0].pluginFacade.format, 'esm-default');
    });
});

test('CommonJS MCP сохраняет require.main, CJS descriptor и прямой запуск', async () => {
    await built('project', async ({ unpacked, descriptor, provenance }) => {
        assert.equal(descriptor.entrypoint, 'entrypoint.cjs');
        assert.equal(execFileSync(process.execPath, [path.join(unpacked, descriptor.entrypoint)], { encoding: 'utf8' }).trim(), 'MCP_MAIN');
        assert.equal(provenance.sources[0].pluginFacade, undefined);
    }, { kind: 'mcp', content: `if(require.main===module)console.log('MCP_MAIN');module.exports=async()=>({});` });
});

test('Facade корректно импортирует вложенный CJS с пробелом и # в имени', async () => {
    await built('files', async ({ unpacked, descriptor }) => {
        const mod = await import(pathToFileURL(path.join(unpacked, descriptor.entrypoint)).href);
        assert.equal(typeof mod.default, 'function');
    }, { filename: 'lib/плагин #1.cjs' });
});

test('Явный package type commonjs нормализует .js, type module сохраняет именованные ESM exports', async () => {
    await built('files', async ({ descriptor }) => assert.equal(descriptor.entrypoint, 'plugin.js.mjs'),
        { filename: 'plugin.js', extra: { 'package.json': '{"type":"commonjs"}' } });
    await built('files', async ({ unpacked, descriptor, provenance }) => {
        assert.equal(descriptor.entrypoint, 'plugin.js');
        assert.equal(provenance.sources[0].pluginFacade, undefined);
        const mod = await import(pathToFileURL(path.join(unpacked, descriptor.entrypoint)).href);
        assert.deepEqual(Object.keys(mod), ['First', 'Second']);
    }, { filename: 'plugin.js', content: 'export const First=async()=>({});export const Second=async()=>({});', extra: { 'package.json': '{"type":"module"}' } });
});

test('Facade не перезаписывает одноимённый пользовательский файл', async () => {
    await assert.rejects(built('files', async () => assert.fail('Сборка не должна завершиться'),
        { extra: { 'plugin.cjs.mjs': 'export default async()=>({});' } }), { code: 'EEXIST' });
});

test('npm .js использует ближайший package type commonjs и сохраняет factory после facade', async () => {
    await built('npm', async ({ unpacked, descriptor }) => {
        assert.equal(descriptor.entrypoint, 'node_modules/fixture-cjs-plugin/plugin.js.mjs');
        const mod = await import(pathToFileURL(path.join(unpacked, descriptor.entrypoint)).href);
        assert.deepEqual(Object.keys(mod), ['default']);
        assert.equal(typeof mod.default, 'function');
    });
});
