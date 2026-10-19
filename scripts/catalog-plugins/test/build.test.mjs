import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';
import { buildRecipe, parseBuildArguments } from '../build.mjs';
import { readyManifest } from '../manifest.mjs';
import { validateRecipe } from '../recipe-schema.mjs';
import { packRuntime } from '../pack.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); } });

async function fixture(kind = 'plugin') {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-builder-')));
    roots.push(root);
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'index.mjs'), 'export default async () => ({})');
    const recipe = { schemaVersion: 1, key: 'example', name: 'Пример расширения', kind, description: 'Проверочный комплект', revision: '1.0.0',
        source: { type: 'files', directory: 'source', entrypoint: 'index.mjs' }, targets: ['darwin-arm64', 'linux-x64-glibc'] };
    const recipePath = path.join(root, 'recipe.json');
    const output = path.join(root, 'output');
    const save = async (value = recipe) => fs.writeFile(recipePath, JSON.stringify(value));
    await save();
    return { root, source, recipe, recipePath, output, save };
}

test('CLI явно отделяет сборку, dry-run и публикацию', () => {
    assert.deepEqual(parseBuildArguments(['--recipe', 'r.json', '--output', 'out']), { recipePath: 'r.json', output: 'out', dryRun: false, publish: false });
    assert.equal(parseBuildArguments(['--recipe', 'r.json', '--output', 'out', '--publish']).publish, true);
    assert.equal(parseBuildArguments(['--recipe', 'r.json', '--output', 'out', '--progress']).progress, true);
    for (const args of [[], ['--recipe', 'r.json'], ['--recipe', 'r', '--output', 'o', '--exec', 'npm install'], ['--recipe', 'r', '--output', 'o', '--dry-run', '--publish'], ['--recipe', 'r', '--output', 'o', '--dry-run', '--dry-run']]) {
        assert.throws(() => parseBuildArguments(args));
    }
});

test('Callback прогресса считает только готовые платформы до и после каждой фактической упаковки', async () => {
    const f = await fixture();
    const events = [];
    await buildRecipe({ recipePath: f.recipePath, output: f.output, onProgress: async event => {
        if (event.completed > 0) {
            const completedTarget = f.recipe.targets[event.completed - 1];
            await fs.access(path.join(f.output, `${f.recipe.key}-${completedTarget}.json`));
        }
        events.push(event);
    } });
    assert.deepEqual(events, [
        { type: 'build-progress', target: 'darwin-arm64', completed: 0, total: 2 },
        { type: 'build-progress', target: 'darwin-arm64', completed: 1, total: 2 },
        { type: 'build-progress', target: 'linux-x64-glibc', completed: 1, total: 2 },
        { type: 'build-progress', target: 'linux-x64-glibc', completed: 2, total: 2 },
    ]);
});

test('CLI --progress выдаёт JSONL, обычный запуск сохраняет единый JSON-результат', async () => {
    const f = await fixture();
    const script = fileURLToPath(new URL('../build.mjs', import.meta.url));
    const args = [script, '--recipe', f.recipePath, '--output', f.output];
    const output = execFileSync(process.execPath, [...args, '--progress'], { encoding: 'utf8' });
    const lines = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.filter(line => line.type === 'build-progress').length, 4);
    assert.equal(lines.at(-1).ok, true);
    const plain = execFileSync(process.execPath, [script, '--recipe', f.recipePath, '--output', path.join(f.root, 'plain-output')], { encoding: 'utf8' });
    assert.equal(JSON.parse(plain).ok, true);
    assert.equal(plain.includes('build-progress'), false);
});

test('Schema отклоняет плавающие версии, команды, TS entrypoint и повтор платформ', async () => {
    const { recipe } = await fixture();
    for (const version of ['latest', '^1.2.3', '~1.2.3', '1.2', 'v1.2.3', '1.2.3-01', 'https://example.test/archive.tgz']) {
        assert.throws(() => validateRecipe({ ...recipe, source: { type: 'npm', package: '@scope/name', version, entrypoint: 'index.js' } }), /точную semver/);
    }
    assert.equal(validateRecipe({ ...recipe, source: { type: 'npm', package: '@scope/name', version: '1.2.3-beta.1+build.2', entrypoint: 'index.js' } }).source.version, '1.2.3-beta.1+build.2');
    assert.throws(() => validateRecipe({ ...recipe, source: { ...recipe.source, entrypoint: 'index.ts' } }), /готовым.*TypeScript/);
    for (const config of [{ command: 'curl' }, { entrypoint: 'other.js' }, { extra: { runtimeArtifacts: [] } }, { install: 'npm install' }]) {
        assert.throws(() => validateRecipe({ ...recipe, config }), /Builder сам задаёт/);
    }
    assert.throws(() => validateRecipe({ ...recipe, targets: ['darwin-arm64', 'darwin-arm64'] }), /targets/);
    assert.throws(() => validateRecipe({ ...recipe, scripts: { build: 'echo no' } }), /Неизвестные поля/);
});

test('Dry-run читает исходники и полностью валидирует config без сети, файлов output и публикации', async () => {
    const f = await fixture('mcp');
    f.recipe.config = { args: ['два слова'], env: { API_KEY: '{env:API_KEY}' } };
    await f.save();
    const before = await fs.readdir(f.root);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Dry-run обратился к сети'); };
    try {
        const result = await buildRecipe({ recipePath: f.recipePath, output: f.output, dryRun: true });
        assert.equal(result.dryRun, true);
        assert.deepEqual(result.targets, f.recipe.targets);
        assert.deepEqual(await fs.readdir(f.root), before);
        await f.save({ ...f.recipe, config: { env: { API_KEY: 'личный секрет' } } });
        await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.output, dryRun: true }), /секрет/);
        await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    } finally { globalThis.fetch = originalFetch; }
});

test('Готовый JS проходит один архивный delivery для MCP и plugin; manifest валиден до публикации', async () => {
    for (const kind of ['mcp', 'plugin']) {
        const f = await fixture(kind);
        const sourceBefore = await fs.readFile(path.join(f.source, 'index.mjs'));
        const result = await buildRecipe({ recipePath: f.recipePath, output: f.output });
        const [tool] = await readyManifest(result.manifest);
        assert.equal(result.runtimeChecked, false);
        assert.equal(tool.publication.kind, kind);
        assert.equal(tool.publication.config.extra.runtimeArtifacts.length, 2);
        assert.equal(tool.publication.config.transport, kind === 'mcp' ? 'stdio' : undefined);
        assert.equal(tool.artifacts[0].descriptor.sha256, tool.artifacts[1].descriptor.sha256);
        const unpacked = path.join(f.root, 'unpacked');
        await runtime.inspectRuntimeArchive(tool.artifacts[0].archivePath, tool.artifacts[0].descriptor, { destination: unpacked });
        assert.deepEqual(await fs.readFile(path.join(unpacked, 'index.mjs')), sourceBefore);
        assert.deepEqual(await fs.readFile(path.join(f.source, 'index.mjs')), sourceBefore);
        const provenance = JSON.parse(await fs.readFile(path.join(f.output, 'provenance.json'), 'utf8'));
        assert.equal(provenance.runtimeChecked, false);
        assert.equal(provenance.artifacts.length, 2);
        assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'recipe.json'), 'utf8')).key, f.recipe.key);
        assert.equal((await fs.readdir(f.output)).some(name => name.startsWith('.build-')), false);
        await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.output }), /новой или пустой/);
    }
});

test('Готовый Mach-O release сохраняет native executable и не описывается как JavaScript', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
    const f = await fixture('mcp');
    const app = path.join(f.root, 'native-app');
    await fs.mkdir(app);
    const source = path.join(f.root, 'native.c');
    await fs.writeFile(source, 'int main(void) { return 0; }\n');
    execFileSync('/usr/bin/clang', ['-arch', 'arm64', source, '-o', path.join(app, 'server')]);
    assert.match(execFileSync('/usr/bin/file', [path.join(app, 'server')], { encoding: 'utf8' }), /Mach-O.*arm64/);
    const archive = path.join(f.root, 'native-release.tar.gz');
    const descriptor = await packRuntime({ directory: app, archivePath: archive, target: 'darwin-arm64', entrypoint: 'server', executables: ['server'] });
    const asset = { url: 'https://example.com/native-release-v1.tar.gz', sha256: descriptor.sha256, format: 'tar.gz', entrypoint: 'server', executables: ['server'] };
    await f.save({ ...f.recipe, source: { type: 'release', assets: { 'darwin-arm64': asset } }, targets: ['darwin-arm64'] });
    let seeded = false;
    const result = await buildRecipe({ recipePath: f.recipePath, output: f.output, onProgress: async () => {
        if (seeded) return;
        seeded = true;
        const cache = path.join(f.output, '.source-cache', 'runtime');
        await fs.mkdir(cache, { recursive: true });
        await fs.copyFile(archive, path.join(cache, asset.sha256));
        await fs.writeFile(path.join(cache, asset.sha256 + '.json'), JSON.stringify({ schemaVersion: 1, url: asset.url, sha256: asset.sha256, compressedBytes: descriptor.compressedBytes }));
    } });
    const [tool] = await readyManifest(result.manifest);
    assert.equal(tool.artifacts[0].descriptor.executable, true);
    assert.equal(tool.artifacts[0].descriptor.entrypoint, 'server');
    assert.match(tool.publication.compatibility, /Готовая поставка релиза/);
    assert.doesNotMatch(tool.publication.compatibility, /JavaScript|встроенный Node/);
});

test('Provenance встроенного рецепта сохраняет переносимый путь к снимку и его SHA', async () => {
    const f = await fixture();
    const virtualRecipe = path.join(f.root, 'project-context.json');
    const recipe = { ...f.recipe, key: 'project-context', source: { type: 'prepared', adapter: 'project-context' }, targets: ['darwin-arm64'] };
    await assert.rejects(fs.access(virtualRecipe), { code: 'ENOENT' });
    await buildRecipe({ recipe, recipePath: virtualRecipe, output: f.output });
    const provenance = JSON.parse(await fs.readFile(path.join(f.output, 'provenance.json'), 'utf8'));
    assert.equal(provenance.recipePath, 'recipe.json');
    const snapshot = JSON.parse(await fs.readFile(path.join(f.output, provenance.recipePath), 'utf8'));
    assert.deepEqual(snapshot, validateRecipe(recipe));
    assert.equal(provenance.recipeSha256, createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'));
    const movedOutput = path.join(f.root, 'moved-output');
    await fs.rename(f.output, movedOutput);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(movedOutput, provenance.recipePath), 'utf8')), snapshot);
    await assert.rejects(fs.access(virtualRecipe), { code: 'ENOENT' });
});

test('Две сборки в одну папку не перезаписывают результат победившего процесса', async () => {
    const f = await fixture();
    const options = { recipePath: f.recipePath, output: f.output };
    const results = await Promise.allSettled([buildRecipe(options), buildRecipe(options)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await readyManifest(path.join(f.output, 'ready.json'))).length, 1);
    assert.equal((await fs.readdir(f.output)).some(name => name.startsWith('.build-')), false);
});

test('Пути source и output не пересекаются в обоих направлениях, ссылки и traversal отклоняются до записи', async () => {
    const f = await fixture();
    await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: path.join(f.source, 'nested'), dryRun: true }), /не должны пересекаться/);
    await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.root, dryRun: true }), /новой или пустой|не должны пересекаться/);
    await f.save({ ...f.recipe, source: { ...f.recipe.source, directory: '../outside' } });
    await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.output }), /внутри папки recipe/);
    await f.save();
    await fs.symlink('index.mjs', path.join(f.source, 'linked.mjs'));
    await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.output }), /Ссылки/);
    await fs.unlink(path.join(f.source, 'linked.mjs'));
    await fs.link(path.join(f.source, 'index.mjs'), path.join(f.source, 'hardlink.mjs'));
    await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.output }), /Ссылки/);
    await fs.unlink(path.join(f.source, 'hardlink.mjs'));
    await fs.symlink(f.source, path.join(f.root, 'linked-source'));
    await f.save({ ...f.recipe, source: { ...f.recipe.source, directory: 'linked-source' } });
    await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.output }), /не должна содержать ссылки/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
});

test('Source files не выдаёт TS, секретный или бинарный файл за готовую поставку', async () => {
    const f = await fixture();
    for (const [name, bytes, expected] of [['source.ts', 'export const x: number = 1', /готовый JavaScript/], ['.env', 'TOKEN=секрет', /Недопустимый путь/], ['binary.bin', Buffer.from([0, 255]), /UTF-8/]]) {
        await fs.writeFile(path.join(f.source, name), bytes);
        await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: f.output }), expected);
        await fs.unlink(path.join(f.source, name));
        await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
    }
});

test('npm обрабатывает каждую платформу без lifecycle и сохраняет upstream CLI guard, locks и provenance', async () => {
    const f = await fixture('mcp');
    const fakeNpm = path.join(f.root, 'npm-fixture.mjs');
    const calls = path.join(f.root, 'npm-calls.jsonl');
    const cli = "import {pathToFileURL} from 'node:url'; if(import.meta.url===pathToFileURL(process.argv[1]).href) console.log('UPSTREAM_MAIN'); export default async()=>({});";
    await fs.writeFile(fakeNpm, `import fs from 'node:fs/promises'; import path from 'node:path';
const args=process.argv.slice(2); const directory=args[args.indexOf('--prefix')+1];
await fs.appendFile(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const input=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8')); const [name,version]=Object.entries(input.dependencies)[0];
const base=path.join(directory,'node_modules',name); await fs.mkdir(path.join(base,'dist'),{recursive:true});
await fs.writeFile(path.join(base,'package.json'),JSON.stringify({name,version,type:'module'}));
await fs.writeFile(path.join(base,'dist/index.js'),${JSON.stringify(cli)});
await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:input.dependencies},['node_modules/'+name]:{version,integrity:'sha512-fixture'}}}));
`);
    await f.save({ ...f.recipe, source: { type: 'npm', package: '@fixture/plugin', version: '1.2.3', entrypoint: 'dist/index.js' } });
    const previous = process.env.NPM_CLI_JS;
    process.env.NPM_CLI_JS = fakeNpm;
    try {
        const result = await buildRecipe({ recipePath: f.recipePath, output: f.output });
        const [tool] = await readyManifest(result.manifest);
        const invocations = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(invocations.length, 2);
        for (const args of invocations) { assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--no-bin-links')); }
        assert.equal(invocations[0][invocations[0].indexOf('--os') + 1], 'darwin');
        assert.equal(invocations[1][invocations[1].indexOf('--os') + 1], 'linux');
        const entrypoint = 'node_modules/@fixture/plugin/dist/index.js';
        assert.equal(tool.artifacts[0].descriptor.entrypoint, entrypoint);
        const unpacked = path.join(f.root, 'unpacked');
        await runtime.inspectRuntimeArchive(tool.artifacts[0].archivePath, tool.artifacts[0].descriptor, { destination: unpacked });
        assert.equal(execFileSync(process.execPath, [path.join(unpacked, entrypoint)], { encoding: 'utf8' }).trim(), 'UPSTREAM_MAIN');
        const provenance = JSON.parse(await fs.readFile(path.join(f.output, 'provenance.json'), 'utf8'));
        assert.equal(provenance.locks.length, 2);
        for (const lock of provenance.locks) { assert.ok((await fs.readFile(path.join(f.output, lock.file), 'utf8')).includes('1.2.3')); }

        await fs.appendFile(fakeNpm, "if(process.argv[process.argv.indexOf('--os')+1]==='linux') throw new Error('Проверочная ошибка второй платформы');\n");
        const failedOutput = path.join(f.root, 'failed-output');
        await assert.rejects(buildRecipe({ recipePath: f.recipePath, output: failedOutput }), /Проверочная ошибка второй платформы/);
        await assert.rejects(fs.access(path.join(failedOutput, 'ready.json')), { code: 'ENOENT' });
        assert.equal((await fs.readdir(failedOutput)).some(name => name.startsWith('.build-')), false);
    } finally { if (previous === undefined) { delete process.env.NPM_CLI_JS; } else { process.env.NPM_CLI_JS = previous; } }
});

for (const [format, extension] of [['esm', 'ts'], ['cjs', 'ts'], ['esm', 'mts'], ['cjs', 'cts']]) test(`npm .${extension} ${format} компилируется в готовый JS с работающим CLI guard`, async () => {
    const f = await fixture('plugin');
    const fakeNpm = path.join(f.root, 'npm-typescript-fixture.mjs');
    const source = format === 'esm' ? `import {pathToFileURL} from 'node:url';
interface Input { directory: string }
export default async function plugin(input: Input) { return {directory: input.directory}; }
if(import.meta.url===pathToFileURL(process.argv[1]).href) console.log('TS_MAIN');`
        : `interface Input { directory: string }
module.exports=async(input: Input)=>({directory:input.directory});
if(require.main===module) console.log('TS_MAIN');`;
    await fs.writeFile(fakeNpm, `import fs from 'node:fs/promises'; import path from 'node:path';
const args=process.argv.slice(2),directory=args[args.indexOf('--prefix')+1];
const input=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8')); const [name,version]=Object.entries(input.dependencies)[0];
const base=path.join(directory,'node_modules',name); await fs.mkdir(base,{recursive:true});
await fs.writeFile(path.join(base,'package.json'),JSON.stringify({name,version,type:${JSON.stringify(format === 'esm' ? 'module' : 'commonjs')}}));
await fs.writeFile(path.join(base,${JSON.stringify('index.' + extension)}),${JSON.stringify(source)});
await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:input.dependencies},['node_modules/'+name]:{version}}}));
`);
    await f.save({ ...f.recipe, targets: ['darwin-arm64'], source: { type: 'npm', package: 'fixture-typescript-plugin', version: '1.2.3', entrypoint: 'index.' + extension } });
    const previous = process.env.NPM_CLI_JS;
    process.env.NPM_CLI_JS = fakeNpm;
    try {
        assert.equal((await buildRecipe({ recipePath: f.recipePath, output: f.output, dryRun: true })).dryRun, true);
        await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
        const result = await buildRecipe({ recipePath: f.recipePath, output: f.output });
        const [tool] = await readyManifest(result.manifest);
        const artifact = tool.artifacts[0];
        const originalEntrypoint = `entrypoint.${format === 'esm' ? 'mjs' : 'cjs'}`;
        const entrypoint = format === 'cjs' ? originalEntrypoint + '.mjs' : originalEntrypoint;
        assert.equal(artifact.descriptor.entrypoint, entrypoint);
        const unpacked = path.join(f.root, 'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath, artifact.descriptor, { destination: unpacked });
        const { default: plugin } = await import(pathToFileURL(path.join(unpacked, entrypoint)));
        assert.deepEqual(await plugin({ directory: 'Проверка' }), { directory: 'Проверка' });
        assert.equal(execFileSync(process.execPath, [path.join(unpacked, originalEntrypoint)], { encoding: 'utf8' }).trim(), 'TS_MAIN');
        assert.match(await fs.readFile(path.join(f.output, 'provenance.json'), 'utf8'), /esbuild/);
        assert.equal(result.runtimeChecked, false);
    } finally { if (previous === undefined) { delete process.env.NPM_CLI_JS; } else { process.env.NPM_CLI_JS = previous; } }
});
