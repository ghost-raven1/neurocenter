import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plugin = 'node_modules/@opencode-ai/plugin';

/** Small real USTAR/GZIP fixtures: no npm, native executable, network or user profile. */
export function sdkTarFixture(files, {types = {}} = {}) {
    const parts = [];
    for (const [file, value] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const bytes = Buffer.from(value), header = Buffer.alloc(512), at = file.lastIndexOf('/');
        const name = Buffer.byteLength(file) <= 100 ? file : file.slice(at + 1), prefix = name === file ? '' : file.slice(0, at);
        if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw Error('Fixture path exceeds USTAR bounds');
        header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
        header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
        header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263); header.write(prefix, 345);
        if (types[file]) { header[156] = types[file].type.charCodeAt(0); if (types[file].linkpath) header.write(types[file].linkpath, 157); }
        header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
        parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

/** Honest source lock entries with synthetic package bodies keep candidate tests small and independent of registry availability. */
export async function bridgeSdkFixture(target, {seed = true, payload = 'isolated runtime', changeFiles, changeManifest, omitPackages = []} = {}) {
    const files = new Map([['dist/index.js', Buffer.from(payload)]]);
    if (!seed) return {bytes: sdkTarFixture(files), files};
    const source = await fs.readFile(new URL('../bridge-opencode-sdk-lock.json', import.meta.url)), lock = JSON.parse(source), packages = {};
    const prefix = 'bin/opencode-sdk/';
    for (const [name, item] of Object.entries(lock.packages)) {
        if (!name) continue;
        const nested = name === plugin || name.startsWith(plugin + '/') ? name : plugin + '/' + name;
        packages[nested] = item;
        if (omitPackages.includes(name)) continue;
        const relative = 'package' + nested.slice(plugin.length);
        files.set(prefix + relative + '/package.json', Buffer.from(JSON.stringify({name: name.split('node_modules/').at(-1), version: item.version})));
        files.set(prefix + relative + '/index.js', Buffer.from('export const fixture = true;\n'));
    }
    files.set(prefix + 'source-lock.json', source);
    files.set(prefix + 'lock-entries.json', Buffer.from(JSON.stringify({schemaVersion: 1, packages}, null, 2) + '\n'));
    const inventory = [...files].filter(([name]) => name.startsWith(prefix)).map(([name, bytes]) => ({path: name.slice(prefix.length), size: bytes.length, sha256: hash(bytes)}))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = {schemaVersion: 1, package: '@opencode-ai/plugin', version: '1.14.48', openCodeVersion: '1.14.48', layout: 'nested-v1', target,
        sourceLockSha256: hash(source), filesCount: inventory.length, bytes: inventory.reduce((sum, file) => sum + file.size, 0), files: inventory};
    changeManifest?.(manifest);
    files.set(prefix + 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    changeFiles?.(files);
    return {bytes: sdkTarFixture(files), files, manifest};
}
