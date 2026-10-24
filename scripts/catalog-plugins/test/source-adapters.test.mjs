import {readyManifest} from '../manifest.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildRecipe } from '../build.mjs';
import { validateRecipe } from '../recipe-schema.mjs';
import { extractRelease, prepareAdditionalSource } from '../source-adapters.mjs';
import { createHash } from 'node:crypto';
import runtime from '../../../services/shared/runtime-artifacts.cjs';
import fixture from '../../test/runtime-artifact-fixture.cjs';

const recipe = { schemaVersion: 1, key: 'typescript-plugin', name: 'Тестовый TS-плагин', kind: 'plugin', revision: '1.0.0', description: 'Проверка настоящей сборки',
    source: { type: 'project', directory: 'source', entrypoint: 'index.ts' }, targets: ['darwin-arm64'] };

test('Исходный TS-плагин компилируется, упаковывается и импортируется из проверенного архива', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-ts-build-')));
    try {
        await fs.mkdir(path.join(root, 'source'));
        await fs.writeFile(path.join(root, 'source/index.ts'), 'interface Input { directory: string }\nexport default async function plugin(input: Input) { return { name: input.directory }; }\n');
        const output = path.join(root, 'output');
        const result = await buildRecipe({ recipe, recipePath: path.join(root, 'recipe.json'), output });
        assert.equal(result.runtimeChecked, false);
        const [built]=await readyManifest(result.manifest);const manifest={tools:[built]};
        const artifact = manifest.tools[0].artifacts[0];
        const descriptor = artifact.descriptor;
        const extracted = path.join(root, 'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath, descriptor, { destination: extracted });
        const { default: plugin } = await import(pathToFileURL(path.join(extracted, descriptor.entrypoint)));
        assert.deepEqual(await plugin({ directory: 'Тест' }), { name: 'Тест' });
        assert.match(await fs.readFile(path.join(output, 'provenance.json'), 'utf8'), /esbuild/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const extension of ['cjs', 'js', 'ts', 'cts']) test(`CommonJS-проект .${extension} сохраняет исходный main guard и отдаёт ESM plugin facade`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-cjs-build-')));
    try {
        await fs.mkdir(path.join(root, 'source'));
        await fs.writeFile(path.join(root, `source/index.${extension}`), "module.exports=async input=>({directory:input.directory}); if(require.main===module)console.log('CJS_MAIN');");
        const output = path.join(root, 'output');
        const result = await buildRecipe({ recipe: { ...recipe, source: { type: 'project', directory: 'source', entrypoint: `index.${extension}` } }, recipePath: path.join(root, 'recipe.json'), output });
        const [built]=await readyManifest(result.manifest);const manifest={tools:[built]};
        const artifact = manifest.tools[0].artifacts[0];
        const descriptor = artifact.descriptor;
        assert.equal(descriptor.entrypoint, 'entrypoint.cjs.mjs');
        const unpacked = path.join(root, 'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath, descriptor, { destination: unpacked });
        const entrypoint = path.join(unpacked, descriptor.entrypoint);
        assert.equal(execFileSync(process.execPath, [path.join(unpacked, 'entrypoint.cjs')], { encoding: 'utf8' }).trim(), 'CJS_MAIN');
        const { default: plugin } = await import(pathToFileURL(entrypoint));
        assert.deepEqual(await plugin({ directory: 'Тест' }), { directory: 'Тест' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('ESM-проект .mts компилируется в JS и сохраняет прямой запуск и import', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-mts-build-')));
    try {
        await fs.mkdir(path.join(root, 'source'));
        await fs.writeFile(path.join(root, 'source/index.mts'), "import {fileURLToPath} from 'node:url';\nexport default async (input: {directory: string}) => ({directory: input.directory});\nif(process.argv[1]===fileURLToPath(import.meta.url))console.log('MTS_MAIN');");
        const output = path.join(root, 'output');
        const result = await buildRecipe({recipe: {...recipe, source: {type: 'project', directory: 'source', entrypoint: 'index.mts'}}, recipePath: path.join(root, 'recipe.json'), output});
        const [built]=await readyManifest(result.manifest),artifact=built.artifacts[0];
        const descriptor = artifact.descriptor;
        assert.equal(descriptor.entrypoint, 'entrypoint.mjs');
        const unpacked = path.join(root, 'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath, descriptor, {destination: unpacked});
        const entrypoint = path.join(unpacked, descriptor.entrypoint);
        assert.equal(execFileSync(process.execPath, [entrypoint], {encoding: 'utf8'}).trim(), 'MTS_MAIN');
        const {default: plugin} = await import(pathToFileURL(entrypoint));
        assert.deepEqual(await plugin({directory: 'Тест'}), {directory: 'Тест'});
    } finally {await fs.rm(root, {recursive: true, force: true});}
});

for (const entrypoint of ['server.d.ts', 'server.d.mts', 'server.d.cts']) test(`Декларация ${entrypoint} отклоняется в рецептах project, repository и npm`, () => {
    for (const source of [{type: 'project', directory: 'source', entrypoint},
        {type: 'repository', url: 'https://github.com/fixture/demo', commit: 'a'.repeat(40), entrypoint},
        {type: 'npm', package: 'fixture', version: '1.0.0', entrypoint}]) {
        assert.throws(() => validateRecipe({...recipe, source}), /JS\/TS/);
    }
});

test('Зависимости сохраняют runtime assets и лицензии, изолируя npmrc и scoped registry из окружения', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-cjs-dependencies-')));
    const previous = process.env.NPM_CLI_JS;
    const npmEnvironment = ['NPM_CONFIG_REGISTRY', 'npm_config_@fixture:registry', 'NPM_CONFIG_USERCONFIG'];
    const previousEnvironment = Object.fromEntries(npmEnvironment.map(key => [key, process.env[key]]));
    try {
        await fs.mkdir(path.join(root, 'source'));
        await fs.writeFile(path.join(root, 'source/package.json'), JSON.stringify({ name: 'source-fixture', type: 'commonjs', dependencies: { 'fixture-helper': '1.0.0' } }));
        await fs.writeFile(path.join(root, 'source/index.js'), "const {value}=require('fixture-helper'); module.exports=async()=>({value}); if(require.main===module)console.log(value);");
        await fs.mkdir(path.join(root, 'source/nested'));
        await fs.writeFile(path.join(root, 'source/.npmrc'), '@fixture:registry=https://untrusted.example');
        await fs.writeFile(path.join(root, 'source/nested/.npmrc'), 'ignore-scripts=false');
        const fakeNpm = path.join(root, 'npm-fixture.mjs');
        await fs.writeFile(fakeNpm, `import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import path from 'node:path';
const args=process.argv.slice(2),directory=args[args.indexOf('--prefix')+1],base=path.join(directory,'node_modules/fixture-helper');
assert.deepEqual(Object.keys(process.env).filter(key=>/^npm_config_/i.test(key)),['npm_config_update_notifier']);
assert.equal(args.includes('--registry=https://registry.npmjs.org'),true);
for(const key of ['--userconfig','--globalconfig']) assert.equal(await fs.readFile(args[args.indexOf(key)+1],'utf8'),'');
for(const name of ['.npmrc','nested/.npmrc']) await assert.rejects(fs.stat(path.join(directory,name)),{code:'ENOENT'});
await fs.mkdir(base,{recursive:true});
await fs.writeFile(path.join(base,'package.json'),JSON.stringify({name:'fixture-helper',version:'1.0.0',main:'index.cjs'}));
await fs.writeFile(path.join(base,'index.cjs'),"exports.value=require('node:fs').readFileSync(require('node:path').join(__dirname,'asset.txt'),'utf8');");
await fs.writeFile(path.join(base,'asset.txt'),'HELPER_MAIN');
await fs.writeFile(path.join(base,'LICENSE'),'Fixture license');
await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));
`);
        process.env.NPM_CLI_JS = fakeNpm;
        for (const key of npmEnvironment) { process.env[key] = 'https://untrusted.example'; }
        const output = path.join(root, 'output');
        const result = await buildRecipe({ recipe: { ...recipe, source: { type: 'project', directory: 'source', entrypoint: 'index.js' } }, recipePath: path.join(root, 'recipe.json'), output });
        const [built]=await readyManifest(result.manifest);const manifest={tools:[built]};
        const snapshot=JSON.parse(await fs.readFile(built.sourceSnapshotPath,'utf8'));
        assert.deepEqual(snapshot.files.map(file=>file.path).sort(),['index.js','package.json']);
        assert.ok(!snapshot.files.some(file=>file.content.includes('https://untrusted.example')||file.content.includes('ignore-scripts=false')));
        assert.equal(await fs.readFile(path.join(root,'source/.npmrc'),'utf8'),'@fixture:registry=https://untrusted.example');
        const artifact = manifest.tools[0].artifacts[0];
        const descriptor = artifact.descriptor;
        assert.equal(descriptor.entrypoint, 'entrypoint.cjs.mjs');
        const unpacked = path.join(root, 'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath, descriptor, { destination: unpacked });
        assert.equal(execFileSync(process.execPath, [path.join(unpacked, 'entrypoint.cjs')], { encoding: 'utf8' }).trim(), 'HELPER_MAIN');
        assert.equal(await fs.readFile(path.join(unpacked, 'node_modules/fixture-helper/asset.txt'), 'utf8'), 'HELPER_MAIN');
        assert.equal(await fs.readFile(path.join(unpacked, 'node_modules/fixture-helper/LICENSE'), 'utf8'), 'Fixture license');
    } finally {
        if (previous === undefined) { delete process.env.NPM_CLI_JS; } else { process.env.NPM_CLI_JS = previous; }
        for (const key of npmEnvironment) {
            if (previousEnvironment[key] === undefined) { delete process.env[key]; } else { process.env[key] = previousEnvironment[key]; }
        }
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('Ссылки и пересечение output с исходниками блокируются до компиляции и записи', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-ts-build-')));
    try {
        await fs.mkdir(path.join(root, 'source')); await fs.writeFile(path.join(root, 'source/index.ts'), 'export default 1;');
        const options = { recipe, recipePath: path.join(root, 'recipe.json'), output: path.join(root, 'source/output'), dryRun: true };
        await assert.rejects(buildRecipe(options), /пересекаться/);
        await fs.symlink('index.ts', path.join(root, 'source/alias.ts'));
        await assert.rejects(buildRecipe({ ...options, output: path.join(root, 'output') }), /ссылки/);
        await assert.rejects(fs.stat(path.join(root, 'output')), { code: 'ENOENT' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Рецепт релиза требует SHA, HTTPS и реально доступную целевую платформу', () => {
    const source = { type: 'release', assets: { 'linux-x64-glibc': { url: 'https://github.com/example/tool/releases/download/v1/release.tgz', sha256: 'a'.repeat(64), format: 'tar.gz', entrypoint: 'server', executables: ['server'] } } };
    assert.deepEqual(validateRecipe({ ...recipe, kind: 'mcp', source, targets: undefined }).targets, ['linux-x64-glibc']);
    assert.throws(() => validateRecipe({ ...recipe, source }), /неподдерживаемую/);
    assert.throws(() => validateRecipe({ ...recipe, source: { ...source, assets: { 'darwin-arm64': { ...source.assets['linux-x64-glibc'], url: 'http://example.test/a' } } } }), /HTTPS/);
});

test('Произвольный release не обходит защиту public HTTPS, byte cap и проверенный cache общего downloader', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-safe-release-'));
    try {
        const bytes = fixture.artifactFixture([{ path: 'server', content: 'ready', mode: 0o755 }]).archive;
        const asset = { url: 'https://github.com/example/tool/releases/download/v1/tool.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), format: 'tar.gz', entrypoint: 'server', executables: ['server'] };
        for (const url of ['https://127.0.0.1/private', 'https://10.0.0.1/private', 'https://localhost/private']) {
            assert.throws(() => validateRecipe({ ...recipe, source: { type: 'release', assets: { 'darwin-arm64': { ...asset, url } } } }), /HTTPS/);
        }
        const cacheDirectory = path.join(root, 'cache'), cache = path.join(cacheDirectory, 'runtime'); await fs.mkdir(cache, { recursive: true });
        await fs.writeFile(path.join(cache, asset.sha256), bytes);
        await fs.writeFile(path.join(cache, asset.sha256 + '.json'), JSON.stringify({ schemaVersion: 1, url: asset.url, sha256: asset.sha256, compressedBytes: bytes.length }));
        const input = { ...recipe, source: { type: 'release', assets: { 'darwin-arm64': asset } } };
        const directory = path.join(root, 'output'); await fs.mkdir(directory);
        const prepared = await prepareAdditionalSource(input, { directory, cacheDirectory, recipeDirectory: root, target: 'darwin-arm64' });
        assert.equal(prepared.entrypoint, 'server'); assert.equal(await fs.readFile(path.join(directory, 'server'), 'utf8'), 'ready');
        await fs.appendFile(path.join(cache, asset.sha256), 'tampered');
        const blocked = path.join(root, 'blocked'); await fs.mkdir(blocked);
        await assert.rejects(prepareAdditionalSource(input, { directory: blocked, cacheDirectory, recipeDirectory: root, target: 'darwin-arm64' }), /SHA-256/);
        assert.deepEqual(await fs.readdir(blocked), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Релиз распаковывает обычный TAR и отклоняет ссылку до извлечения первого файла', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-release-'));
    try {
        const archive = path.join(root, 'good.tar.gz');
        await fs.writeFile(archive, fixture.artifactFixture([{ path: 'bin/server', content: 'native', mode: 0o755 }]).archive);
        const destination = path.join(root, 'unpacked'); await fs.mkdir(destination);
        await extractRelease(archive, { format: 'tar.gz', executables: ['bin/server'] }, destination);
        assert.equal(await fs.readFile(path.join(destination, 'bin/server'), 'utf8'), 'native');
        const bad = path.join(root, 'bad.tar.gz');
        await fs.writeFile(bad, fixture.artifactFixture([{ path: 'first.txt', content: 'safe' }, { path: 'link', type: '2', link: '../outside' }]).archive);
        const blocked = path.join(root, 'blocked'); await fs.mkdir(blocked);
        await assert.rejects(extractRelease(bad, { format: 'tar.gz' }, blocked), /Ссылка/);
        assert.deepEqual(await fs.readdir(blocked), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
