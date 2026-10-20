import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../upstream.mjs';
import {loadRepository} from '@neurocenter/asset-contract';
import {readyManifest} from '../../manifest.mjs';

const [directory, report] = process.argv.slice(2).map(value => path.resolve(value));
const source=await loadRepository(directory),tools=(await Promise.all(source.assets.map(item=>readyManifest(path.join(directory,item.path))))).flat();
const native = {
    'darwin-arm64': 'darwin-arm64',
    'linux-arm64-glibc': 'linux-arm64-gnu', 'linux-arm64-musl': 'linux-arm64-musl',
    'linux-x64-glibc': 'linux-x64-gnu', 'linux-x64-musl': 'linux-x64-musl',
    'win32-arm64': 'win32-arm64-msvc', 'win32-x64': 'win32-x64-msvc',
};
const verified = [];
for (const tool of tools) {
    for (const artifact of tool.artifacts) {
        const descriptor=artifact.descriptor;
        const { stdout } = await run('tar', ['-tzf', artifact.archivePath]);
        const entries = stdout.split('\n').filter(Boolean);
        assert.equal(entries.length, descriptor.filesCount);
        if (['opencode-rag', 'opencode-rag-plugin'].includes(tool.key)) {
            const libraries = [...new Set(entries.filter(name => name.startsWith('node_modules/@lancedb/lancedb-')).map(name => name.split('/')[2]))];
            const expected = 'lancedb-' + native[descriptor.target];
            assert.ok(libraries.includes(expected));
            // Upstream Linux optional packages объявляют OS/CPU без libc: npm включает обе libc.
            const allowed = descriptor.target.startsWith('linux-')
                ? ['lancedb-linux-' + descriptor.target.split('-')[1] + '-gnu', 'lancedb-linux-' + descriptor.target.split('-')[1] + '-musl']
                : [expected];
            assert.ok(libraries.every(name => allowed.includes(name)));
            assert.ok(entries.some(name => /node_modules\/@lancedb\/.*\.(?:node|dll|so|dylib)$/.test(name)));
            assert.ok(entries.some(name => name.startsWith('upstream/wasm/') && name.endsWith('.wasm')));
            assert.ok(!entries.some(name => name.startsWith('node_modules/@opencode/')));
            if (tool.key === 'opencode-rag-plugin') {
                assert.ok(entries.includes('rag-plugin.mjs'));
                assert.ok(entries.includes('rag-plugin-config.mjs'));
                for (const helper of ['rag-index-profile.mjs', 'rag-index-lock.mjs', 'rag-index-contract.cjs']) assert.ok(entries.includes(helper));
                assert.ok(entries.includes('node_modules/@opencode-ai/plugin/package.json'));
            }
        } else {
            assert.ok(entries.includes(descriptor.target.startsWith('win32-') ? 'bin/snip.exe' : 'bin/snip'));
            assert.ok(entries.includes('plugin.mjs'));
            assert.ok(!entries.some(name => name.startsWith('node_modules/')));
        }
        verified.push({ tool: tool.key, ...descriptor });
    }
}
assert.ok(tools.length > 0);
for (const [key, expected] of [['opencode-rag', 7], ['opencode-rag-plugin', 7], ['opencode-snip', 8]]) {
    assert.equal(verified.filter(value => value.tool === key).length, tools.some(tool => tool.key === key) ? expected : 0);
}
const value = { status: 'passed', kind: 'static-platform-inventory', nativeExecution: 'darwin-arm64 only; see native smoke', artifacts: verified };
if (report) await fs.writeFile(report, JSON.stringify(value, null, 2) + '\n');
console.log(JSON.stringify({ status: value.status, artifacts: verified.length }));
