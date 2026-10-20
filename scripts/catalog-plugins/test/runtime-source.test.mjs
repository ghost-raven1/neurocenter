import {readyManifest} from '../manifest.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { validateRecipe } from '../recipe-schema.mjs';
import { buildRecipe } from '../build.mjs';
import { inspectRuntimeSource, prepareRuntimeSource, downloadRuntimeAsset } from '../runtime-source.mjs';
import { extractRelease } from '../source-adapters.mjs';
import { packRuntime } from '../pack.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';
import fixture from '../../test/runtime-artifact-fixture.cjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const remote = bytes => ({ url: 'https://github.com/owner/tool/releases/download/v1/tool.tgz', sha256: digest(bytes), format: 'tar.gz', entrypoint: 'bin/runner' });
const recipe = source => ({ schemaVersion: 1, key: 'runtime-fixture', name: 'Автономный MCP', kind: 'mcp', description: 'Проверка runtime', revision: '1.0.0', source });
const source = (adapter, app, binary) => ({ type: 'runtime', adapter, assets: { 'darwin-arm64': { app, ...(binary ? { runtime: binary } : {}) } } });
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter runtime ')).then(value => fs.realpath(value));

function transport(responses, addresses = [{ address: '8.8.8.8', family: 4 }]) {
    const requests = [];
    return { requests, lookup: async () => addresses, request(url, options, callback) {
        const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = error => request.emit('error', error);
        request.end = () => queueMicrotask(() => {
            requests.push({ url: url.href, options });
            options.lookup(url.hostname, { all: true }, (error, selected) => { assert.equal(error, null); assert.deepEqual(selected, addresses); });
            const item = responses.shift(); const response = Readable.from(item.bytes ? [item.bytes] : []);
            response.statusCode = item.status ?? 200; response.headers = item.headers ?? {}; callback(response);
        });
        return request;
    } };
}

test('Публичные redirect закрепляют DNS соединения, SHA и cache; private DNS и подмена блокируются', async () => {
    const root = await temporary();
    try {
        const bytes = Buffer.from('ready binary'), asset = { ...remote(bytes), format: 'file', entrypoint: 'runner' };
        const network = transport([{ status: 302, headers: { location: 'https://release-assets.githubusercontent.com/tool' } }, { bytes }]);
        const actual = await downloadRuntimeAsset(asset, root, network);
        assert.equal(actual.sha256, digest(bytes)); assert.equal(network.requests.length, 2);
        assert.equal(network.requests[1].options.headers.Authorization, undefined);
        await downloadRuntimeAsset(asset, root, network); assert.equal(network.requests.length, 2);
        await fs.chmod(actual.filename, 0o600); await fs.appendFile(actual.filename, 'bad');
        await assert.rejects(downloadRuntimeAsset(asset, root, network), /SHA-256/);
        const blocked = transport([], [{ address: '127.0.0.1', family: 4 }]);
        await assert.rejects(downloadRuntimeAsset(asset, path.join(root, 'private'), blocked), /непубличную/);
        assert.equal(blocked.requests.length, 0);
        const redirect = transport([{ status: 302, headers: { location: 'http://localhost/private' } }]);
        await assert.rejects(downloadRuntimeAsset(asset, path.join(root, 'redirect'), redirect), /HTTPS/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Ошибочная SHA, переполнение, обрыв и цикл redirect не оставляют готовые байты', async () => {
    const root = await temporary();
    try {
        const bytes = Buffer.from('binary'), asset = { ...remote(bytes), format: 'file' };
        for (const [name, responses] of [
            ['sha', [{ bytes: Buffer.from('other') }]], ['overflow', [{ bytes, headers: { 'content-length': String(256 * 1024 ** 2 + 1) } }]],
            ['truncated', [{ bytes, headers: { 'content-length': '200' } }]],
            ['redirect', Array.from({ length: 4 }, () => ({ status: 302, headers: { location: asset.url } }))],
        ]) {
            const directory = path.join(root, name);
            await assert.rejects(downloadRuntimeAsset(asset, directory, transport(responses)));
            assert.deepEqual(await fs.readdir(directory), []);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Dry-run сохраняет MCP-only и target subset, исключает секреты, ссылки и пересечение папок', async () => {
    const root = await temporary();
    try {
        await fs.mkdir(path.join(root, 'ready')); await fs.writeFile(path.join(root, 'ready/tool'), 'ready');
        await fs.writeFile(path.join(root, 'ready/.env'), 'secret'); await fs.mkdir(path.join(root, 'ready/.git'));
        const input = source('native', { directory: 'ready', entrypoint: 'tool' });
        assert.deepEqual(validateRecipe(recipe(input)).targets, ['darwin-arm64']);
        assert.throws(() => validateRecipe({ ...recipe(input), kind: 'plugin' }), /только MCP/);
        await inspectRuntimeSource(input, { recipeDirectory: root, output: path.join(root, 'output') });
        await assert.rejects(inspectRuntimeSource(input, { recipeDirectory: root, output: path.join(root, 'ready/output') }), /пересекаться/);
        await fs.symlink('tool', path.join(root, 'ready/alias'));
        await assert.rejects(inspectRuntimeSource(input, { recipeDirectory: root }), /ссылки/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function runner(root) {
    const input = path.join(root, 'runner.c'), output = path.join(root, 'runner');
    await fs.writeFile(input, '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\n#include <signal.h>\nint main(int argc,char**argv){for(int i=1;i<argc;i++)printf("ARG:%s\\n",argv[i]);char cwd[4096];printf("CWD:%s\\n",getcwd(cwd,sizeof(cwd)));printf("TEMP:%s\\n",getenv("TMPDIR"));printf("HOOK:%s\\n",getenv("JAVA_TOOL_OPTIONS")?"BAD":"NONE");printf("JAVA_HOME:%s\\n",getenv("JAVA_HOME")?getenv("JAVA_HOME"):"NONE");fflush(stdout);for(int i=1;i<argc;i++){if(!strcmp(argv[i],"--wait")){while(1)pause();}if(!strcmp(argv[i],"--ignore")){signal(SIGTERM,SIG_IGN);while(1)pause();}if(!strcmp(argv[i],"--exit=7"))return 7;}return 0;}');
    execFileSync('/usr/bin/cc', [input, '-o', output]);
    return fs.readFile(output);
}

for (const adapter of ['python', 'java', 'dotnet']) test(`Launcher ${adapter} сохраняет пути с пробелами, args/cwd/exit и temp вне cache`, { skip: process.platform === 'win32' }, async () => {
    const root = await temporary();
    try {
        const app = path.join(root, 'ready app'), directory = path.join(root, 'artifact'), project = path.join(root, 'project cwd');
        await Promise.all([fs.mkdir(app), fs.mkdir(directory), fs.mkdir(project)]);
        const entrypoint = { python: 'main.py', java: 'tool.jar', dotnet: 'tool.dll' }[adapter];
        await fs.writeFile(path.join(app, entrypoint), 'prepared'); await fs.writeFile(path.join(app, '.env'), 'secret');
        const archive = fixture.artifactFixture([{ path: 'bin/runner', content: await runner(root) }, { path: 'LICENSE', content: 'Runtime license' }]).archive;
        const filename = path.join(root, 'runtime.tar.gz'); await fs.writeFile(filename, archive);
        const prepared = await prepareRuntimeSource(recipe(source(adapter, { directory: 'ready app', entrypoint }, remote(archive))),
            { directory, recipeDirectory: root, target: 'darwin-arm64' }, { extractRelease, downloadAsset: async () => ({ filename, sha256: digest(archive), compressedBytes: archive.length }) });
        const descriptor = await packRuntime({ directory, archivePath: path.join(root, 'ready.tgz'), target: 'darwin-arm64', ...prepared });
        const unpacked = path.join(root, 'readonly cache'); await runtime.inspectRuntimeArchive(path.join(root, 'ready.tgz'), descriptor, { destination: unpacked });
        await fs.chmod(unpacked, 0o555);
        const child = spawn(process.execPath, [path.join(unpacked, prepared.entrypoint), 'space value', '--exit=7'], { cwd: project, env: { ...process.env, JAVA_TOOL_OPTIONS: 'bad', JAVA_HOME: '/untrusted-jdk', PYTHONPATH: '/untrusted' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', chunk => { output += chunk; });
        const [code] = await once(child, 'exit'); assert.equal(code, 7);
        assert.ok(output.includes('ARG:space value\n')); assert.ok(output.includes('CWD:' + project + '\n')); assert.ok(output.includes('HOOK:NONE'));
        if (adapter === 'python') assert.ok(output.startsWith('ARG:-B\nARG:-E\nARG:-s\n'));
        if (adapter === 'java') {
            assert.ok(output.includes('ARG:-jar\n')); assert.ok(output.includes('JAVA_HOME:' + path.join(unpacked, 'runtime') + '\n'));
            for (const property of ['file.encoding', 'stdout.encoding', 'stderr.encoding']) assert.ok(output.includes(`ARG:-D${property}=UTF-8\n`));
        }
        const temp = output.match(/TEMP:(.*)/)[1]; assert.equal(temp.startsWith(unpacked), false); await assert.rejects(fs.stat(temp), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(unpacked, 'app/.env')), { code: 'ENOENT' });
        assert.equal(await fs.readFile(path.join(unpacked, 'runtime/LICENSE'), 'utf8'), 'Runtime license');
        await fs.chmod(unpacked, 0o755);
    } finally {
        await fs.chmod(path.join(root, 'readonly cache'), 0o755).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('Java launcher выбирает bundled JAVA_HOME и для плоской поставки, игнорируя пользовательский JDK', { skip: process.platform === 'win32' }, async () => {
    const root = await temporary();
    try {
        const directory = path.join(root, 'artifact'); await fs.mkdir(directory); await fs.mkdir(path.join(root, 'app')); await fs.writeFile(path.join(root, 'app/tool.jar'), 'prepared');
        const bytes = await runner(root), filename = path.join(root, 'runner.bin'); await fs.writeFile(filename, bytes);
        const asset = { ...remote(bytes), format: 'file', entrypoint: 'java' };
        const prepared = await prepareRuntimeSource(recipe(source('java', { directory: 'app', entrypoint: 'tool.jar' }, asset)),
            { directory, recipeDirectory: root, target: 'darwin-arm64' }, { extractRelease, downloadAsset: async () => ({ filename }) });
        const output = execFileSync(process.execPath, [path.join(directory, prepared.entrypoint)], { env: { ...process.env, JAVA_HOME: '/untrusted-jdk' }, encoding: 'utf8' });
        assert.ok(output.includes('JAVA_HOME:' + path.join(directory, 'runtime') + '\n'));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Launcher передаёт SIGTERM и ограниченно завершает runtime, игнорирующий сигнал', { skip: process.platform === 'win32' }, async () => {
    const root = await temporary();
    try {
        const directory = path.join(root, 'artifact'); await fs.mkdir(directory); await fs.mkdir(path.join(root, 'app')); await fs.writeFile(path.join(root, 'app/main.py'), 'prepared');
        const bytes = await runner(root), filename = path.join(root, 'runner.bin'); await fs.writeFile(filename, bytes);
        const asset = { ...remote(bytes), format: 'file' };
        const prepared = await prepareRuntimeSource(recipe(source('python', { directory: 'app', entrypoint: 'main.py' }, asset)), { directory, recipeDirectory: root, target: 'darwin-arm64' }, { extractRelease, downloadAsset: async () => ({ filename }) });
        for (const [argument, signal] of [['--wait', 'SIGTERM'], ['--ignore', 'SIGKILL']]) {
            const child = spawn(process.execPath, [path.join(directory, prepared.entrypoint), argument], { stdio: ['ignore', 'pipe', 'pipe'] });
            const started = await once(child.stdout, 'data'); assert.match(String(started[0]), /ARG/);
            // Вывод уже сброшен; даём fixture установить обработчик перед проверкой сигнала.
            await new Promise(resolve => setTimeout(resolve, 20)); child.kill('SIGTERM');
            const [, actual] = await once(child, 'exit'); assert.equal(actual, signal);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Готовый Go/Rust/native binary проходит общий builder с executable descriptor без системного runtime', { skip: process.platform === 'win32' }, async () => {
    const root = await temporary();
    try {
        await fs.mkdir(path.join(root, 'app'));
        await fs.writeFile(path.join(root, 'app/tool'), await runner(root));
        for (const adapter of ['go', 'rust', 'native']) {
            const output = path.join(root, adapter);
            const result = await buildRecipe({ recipe: recipe(source(adapter, { directory: 'app', entrypoint: 'tool' })), recipePath: path.join(root, 'recipe.json'), output });
            assert.equal(result.runtimeChecked, false);
            const [tool]=await readyManifest(result.manifest);
            assert.match(tool.publication.compatibility, /Автономный/); assert.doesNotMatch(tool.publication.compatibility, /JavaScript/);
            const artifact = tool.artifacts[0], descriptor = artifact.descriptor;
            assert.equal(descriptor.entrypoint, 'app/tool'); assert.equal(descriptor.executable, true);
            const unpacked = path.join(root, adapter + '-unpacked');
            await runtime.inspectRuntimeArchive(artifact.archivePath, descriptor, { destination: unpacked });
            const child = spawn(path.join(unpacked, descriptor.entrypoint), ['--exit=7'], { stdio: 'ignore' });
            const [code] = await once(child, 'exit'); assert.equal(code, 7);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Пустой или отсутствующий app entrypoint и подменённый internal download hook не дают успешную поставку', async () => {
    const root = await temporary();
    try {
        const bytes = fixture.artifactFixture([{ path: 'different.py', content: 'ready' }]).archive;
        const filename = path.join(root, 'ready.tgz'); await fs.writeFile(filename, bytes);
        const app = { ...remote(bytes), entrypoint: 'missing.py' }, binary = { ...remote(bytes), entrypoint: 'different.py' };
        for (const modified of [false, true]) {
            const directory = path.join(root, modified ? 'tampered' : 'missing'); await fs.mkdir(directory);
            const selected = modified ? { ...app, sha256: '0'.repeat(64) } : app;
            await assert.rejects(prepareRuntimeSource(recipe(source('python', selected, binary)), { directory, recipeDirectory: root, target: 'darwin-arm64' },
                { extractRelease, downloadAsset: async () => ({ filename }) }));
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
