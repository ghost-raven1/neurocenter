import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectReadyPayload, executableTargets, inspectGithubReleaseAsset, inspectGithubRepository } from '../release-inspection.mjs';
import { buildRecipe } from '../build.mjs';
import fixture from '../../test/runtime-artifact-fixture.cjs';
const require = createRequire(import.meta.url);
const source = require('../../../services/shared/repository-source.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = 'a'.repeat(40);
function mach(arch = 'arm64') {
    const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4);
    bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20); bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(1, 40); return bytes;
}
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-release-test-'));
async function write(root, name, bytes) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), bytes); }
async function inspection(root, files, selected, options = {}) {
    const bytes = fixture.artifactFixture(files).archive, filename = path.join(root, 'archive-' + hash(bytes)); await fs.writeFile(filename, bytes);
    const asset = { id: 4, name: 'tool.tar.gz', url: 'https://github.com/owner/repo/releases/download/v1/tool.tar.gz', bytes: bytes.length, format: 'tar.gz', sha256: hash(bytes) };
    return inspectGithubReleaseAsset(asset, selected, { downloadAsset: async () => ({ filename, sha256: hash(bytes), compressedBytes: bytes.length }), ...options });
}
test('Actual Mach-O/ELF/PE headers establish platform; names, libraries and shell scripts do not', () => {
    assert.deepEqual(executableTargets(mach()), ['darwin-arm64']);
    const library = mach(); library.writeUInt32LE(6, 12); assert.deepEqual(executableTargets(library), []);
    const ios = mach(); ios.writeUInt32LE(2, 40); assert.deepEqual(executableTargets(ios), []);
    assert.deepEqual(executableTargets(Buffer.from('#!/bin/sh\nexit 0')), []);
    const elf = Buffer.alloc(64); elf.set([127, 69, 76, 70, 2, 1]); elf.writeUInt16LE(2, 16); elf.writeUInt16LE(62, 18); elf.writeBigUInt64LE(1n, 24); elf.writeUInt16LE(56, 54);
    assert.deepEqual(executableTargets(elf), ['linux-x64-glibc', 'linux-x64-musl']);
});
test('Two native commands require explicit choice and preserve actual platform of chosen executable', async () => {
    const root = await temp();
    try {
        const files = [{ path: 'bin/first', content: mach() }, { path: 'bin/second', content: mach('x64') }];
        const unknown = await inspection(root, files);
        assert.equal(unknown.entrypoint, ''); assert.equal(unknown.runtimeSource, undefined); assert.deepEqual(unknown.candidates, ['bin/first', 'bin/second']);
        const chosen = await inspection(root, files, 'bin/second');
        assert.deepEqual(Object.keys(chosen.runtimeSource.assets), ['darwin-x64']); assert.equal(chosen.runtimeSource.assets['darwin-x64'].app.entrypoint, 'bin/second');
        await assert.rejects(inspection(root, files, 'missing'), /отсутствует/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Python source receives a pinned runtime while an existing bundled runtime remains unchanged', async () => {
    const root = await temp();
    try {
        await write(root, 'main.py', "if __name__ == '__main__':\n    print('ready')\n");
        const automatic=await detectReadyPayload(root);assert.equal(automatic[0].python.entry.type,'script');assert.ok(automatic[0].runtimeAssets['darwin-arm64'].sha256);
        await write(root, 'python/bin/python3', mach());
        await write(root, 'python/bin/runtime-helper', mach());
        const choices = await detectReadyPayload(root);
        assert.equal(choices.length, 1); assert.deepEqual(choices[0], { entrypoint: 'main.py', runtimeEntrypoint: 'python/bin/python3', adapter: 'python', targets: ['darwin-arm64'] });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Archive traversal, symlinks, case collisions and corrupt bytes fail before any generated recipe', async () => {
    const root = await temp();
    try {
        for (const files of [
            [{ path: '../escape', content: mach() }], [{ path: 'bin/tool', type: 'SymbolicLink', linkpath: '/bin/sh' }],
            [{ path: 'Tool', content: mach() }, { path: 'tool', content: mach() }],
        ]) await assert.rejects(inspection(root, files));
        const filename = path.join(root, 'broken'); await fs.writeFile(filename, 'not-a-zip');
        await assert.rejects(inspectGithubReleaseAsset({ name: 'broken.zip', format: 'zip', bytes: 9, url: 'https://example.com/broken.zip' }, '', { downloadAsset: async () => ({ filename, compressedBytes: 9, sha256: hash('not-a-zip') }) }));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Ready repository detects runtime without neurocenter.tool.json and packages it through native delivery 5 + source envelope', async () => {
    const root = await temp();
    try {
        const bytes = fixture.artifactFixture([{ path: `repo-${commit}/bin/tool`, content: mach() }]).archive;
        const archivePath = path.join(root, 'repo.tar.gz'); await fs.writeFile(archivePath, bytes);
        const pin = { type: 'repository', url: 'https://github.com/owner/repo', commit };
        const detected = await inspectGithubRepository(pin, undefined, { downloadArchive: async () => ({ archivePath, sha256: hash(bytes) }) });
        assert.equal(detected.entrypoint, 'bin/tool'); assert.equal(detected.adapter, 'native'); assert.equal(detected.snapshotSha256, hash(bytes));
        const checked = source.validateRepositorySource({ ...pin, entrypoint: detected.entrypoint, runtimeSource: detected.runtimeSource, snapshotSha256: detected.snapshotSha256 });
        const previous = globalThis.fetch;
        globalThis.fetch = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
        try {
            const output = path.join(root, 'output');
            await buildRecipe({ recipePath: path.join(root, 'recipe.json'), output, recipe: { schemaVersion: 1, key: 'auto-native', name: 'Auto native', description: 'Inspected ready payload', kind: 'mcp', revision: commit, source: checked, targets: ['darwin-arm64'] } });
            const asset = JSON.parse(await fs.readFile(path.join(output, 'asset.json')));
            assert.equal(asset.source.type, 'git'); assert.equal(asset.delivery.artifacts.length, 1);
            assert.equal(asset.delivery.artifacts[0].descriptor.target, 'darwin-arm64'); assert.equal(asset.delivery.artifacts[0].descriptor.entrypoint, 'app/bin/tool');
        } finally { globalThis.fetch = previous; }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('A real HTTP stream establishes missing SHA, retains checked cache and rejects interrupted size', async () => {
    const { createServer, request } = await import('node:http');
    const { downloadRuntimeCandidate } = await import('../runtime-source.mjs');
    const root = await temp(), bytes = Buffer.from('real release body');
    const server = createServer((_req, response) => { response.setHeader('content-length', bytes.length); response.end(bytes); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const port = server.address().port;
        const transport = { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: (_url, options, callback) => request({ ...options, host: '127.0.0.1', port, path: '/release' }, callback) };
        const asset = { url: 'https://github.com/owner/repo/releases/download/v1/program', format: 'file', bytes: bytes.length };
        const downloaded = await downloadRuntimeCandidate(asset, root, transport);
        assert.equal(downloaded.sha256, hash(bytes)); assert.deepEqual(await fs.readFile(downloaded.filename), bytes);
        assert.equal((await fs.stat(downloaded.filename)).nlink, 1);
        assert.equal((await downloadRuntimeCandidate({ ...asset, sha256: hash(bytes) }, root, transport)).sha256, hash(bytes));
        await assert.rejects(downloadRuntimeCandidate({ ...asset, bytes: bytes.length + 1 }, root, transport), /Размер/);
        assert.equal((await fs.readdir(root)).some(name => name.endsWith('.partial')), false);
    } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

function zip(files, badCrc = false) {
    const { crc32, deflateRawSync } = require('node:zlib'); const records = [], directory = []; let offset = 0;
    for (const [filename, value] of Object.entries(files)) {
        const name = Buffer.from(filename), bytes = Buffer.from(value), compressed = deflateRawSync(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46), checksum = badCrc ? 123 : crc32(bytes);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
        central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
        records.push(local, name, compressed); directory.push(central, name); offset += 30 + name.length + compressed.length;
    }
    const end = Buffer.alloc(22), central = Buffer.concat(directory); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...records, central, end]);
}
test('JVM Main-Class plus bundled Java generates recipe; a library JAR does not', async () => {
    const root = await temp();
    try {
        await write(root, 'java/bin/java', mach());
        await write(root, 'server.jar', zip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nMain-Class: example.Server\n' }));
        const choices = await detectReadyPayload(root); assert.equal(choices.length, 1); assert.equal(choices[0].adapter, 'java'); assert.equal(choices[0].entrypoint, 'server.jar');
        await fs.writeFile(path.join(root, 'server.jar'), zip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n' }));
        await assert.rejects(detectReadyPayload(root), /не найден/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('.NET requires managed assembly and runtimeconfig, never plain text named DLL', async () => {
    const root = await temp();
    try {
        await write(root, 'dotnet/dotnet', mach()); await write(root, 'Server.runtimeconfig.json', JSON.stringify({ runtimeOptions: { tfm: 'net8.0' } })); await write(root, 'Server.dll', 'not an assembly');
        await assert.rejects(detectReadyPayload(root), /готовую сборку DLL/);
        const dll = Buffer.alloc(512); dll.write('MZ'); dll.writeUInt32LE(64, 60); dll.write('PE\0\0', 64); dll.writeUInt16LE(0x20b, 88); dll.writeUInt32LE(1, 312);
        await fs.writeFile(path.join(root, 'Server.dll'), dll); const choices = await detectReadyPayload(root); assert.equal(choices.length, 1); assert.equal(choices[0].adapter, 'dotnet');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('.NET framework-dependent apphost requires runtime; self-contained host needs included frameworks and runtime libraries', async () => {
    const root=await temp();
    try {
        const dll=Buffer.alloc(512);dll.write('MZ');dll.writeUInt32LE(64,60);dll.write('PE\0\0',64);dll.writeUInt16LE(0x20b,88);dll.writeUInt32LE(1,312);
        await write(root,'Server.dll',dll);await write(root,'Server',mach());await write(root,'Server.runtimeconfig.json',JSON.stringify({runtimeOptions:{tfm:'net8.0',framework:{name:'Microsoft.NETCore.App',version:'8.0.0'}}}));
        await assert.rejects(detectReadyPayload(root),/runtime/);
        await write(root,'Server.runtimeconfig.json',JSON.stringify({runtimeOptions:{tfm:'net8.0',includedFrameworks:[{name:'Microsoft.NETCore.App',version:'8.0.0'}]}}));
        await assert.rejects(detectReadyPayload(root),/runtime/);
        await write(root,'libhostfxr.dylib','runtime library');await write(root,'libcoreclr.dylib','runtime library');
        assert.deepEqual(await detectReadyPayload(root),[{entrypoint:'Server',adapter:'native',targets:['darwin-arm64']}]);
    } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('ZIP CRC corruption and parent path case aliasing are rejected before recipe generation', async () => {
    const root = await temp();
    try {
        const bytes = zip({ program: mach() }, true), filename = path.join(root, 'corrupt.zip'); await fs.writeFile(filename, bytes);
        await assert.rejects(inspectGithubReleaseAsset({ name: 'program.zip', format: 'zip', bytes: bytes.length, url: 'https://example.com/program.zip' }, undefined, { downloadAsset: async () => ({ filename, sha256: hash(bytes), compressedBytes: bytes.length }) }), /CRC/);
        await assert.rejects(inspection(root, [{ path: 'Bin/first', content: mach() }, { path: 'bin/second', content: mach() }]), /регистр|Unicode/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('A real host executable is inspected without running it', { skip: process.platform !== 'darwin' }, async () => {
    const root = await temp();
    try {
        await fs.copyFile('/usr/bin/true', path.join(root, 'program'));
        const choices = await detectReadyPayload(root);
        assert.equal(choices.length, 1); assert.ok(choices[0].targets.includes('darwin-' + process.arch));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
