import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, extract, TARGETS } from './upstream.mjs';

export const SNIP_VERSION = '0.25.2';
export const SNIP_PLUGIN_VERSION = '2.0.0';
const release = 'https://github.com/edouard-claude/snip/releases/download/v' + SNIP_VERSION + '/';
const assets = {
    'darwin-arm64': ['darwin_arm64.tar.gz', 'a495b8b91cc1d51cffd0b4490e536b96cd026f5080b39e1736a29580ec335465'],
    'darwin-x64': ['darwin_amd64.tar.gz', '7e2ddb1c3578f0c185f5544114690b0c26391948d57edaef98b87d15f479ba0c'],
    'linux-arm64': ['linux_arm64.tar.gz', '969194300bdf47371c68f30629b8692f2451c39b77a6a823dc6fc88e736e7449'],
    'linux-x64': ['linux_amd64.tar.gz', 'f75272d9e55ff6e9bedf5f18a13450907f62f747a8b43d03ca703b82357418e8'],
    'win32-arm64': ['windows_arm64.zip', 'caf829f12cb467cbdac3b6c58c527ac2ab96bea19b7f061ebe572a66e5ddf29e'],
    'win32-x64': ['windows_amd64.zip', '5bd0d71aea0ae82485e4b5c52f17664b4ca59f37463dc57aec3929399207b051'],
};

/** Плагин и CLI закреплены вместе; PATH и настройки оболочки пользователя не меняются. */
export async function prepareOpenCodeSnip({ target, directory }) {
    if (!TARGETS[target]) throw new Error('Неизвестная платформа: ' + target);
    const [suffix, sha256] = assets[target.replace(/-(?:glibc|musl)$/, '')];
    const archive = await download(release + 'snip_' + SNIP_VERSION + '_' + suffix, sha256);
    const unpacked = await fs.mkdtemp(path.join(path.dirname(directory), 'snip-source-'));
    try {
        await extract(archive, unpacked, suffix.endsWith('.zip') ? 'zip' : 'tar');
        await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
        const binary = target.startsWith('win32-') ? 'snip.exe' : 'snip';
        await fs.copyFile(path.join(unpacked, binary), path.join(directory, 'bin', binary));
        await fs.chmod(path.join(directory, 'bin', binary), 0o755);
        await fs.copyFile(path.join(unpacked, 'LICENSE'), path.join(directory, 'SNIP-LICENSE'));
        const plugin = await download('https://registry.npmjs.org/opencode-snip/-/opencode-snip-2.0.0.tgz',
            'd6cf0ccb34bb2edd4641ac4180c502974189c46d656c06847cb19b6b5500b960');
        await extract(plugin, path.join(unpacked, 'plugin'));
        await fs.mkdir(path.join(directory, 'upstream'), { recursive: true });
        await fs.copyFile(path.join(unpacked, 'plugin/package/src/index.ts'), path.join(directory, 'upstream/opencode-snip.ts'));
        await fs.copyFile(path.join(unpacked, 'plugin/package/LICENSE'), path.join(directory, 'OPENCODE-SNIP-LICENSE'));
        await fs.copyFile(fileURLToPath(new URL('./adapters/snip-plugin.mjs', import.meta.url)), path.join(directory, 'plugin.mjs'));
        await fs.writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
        return { entrypoint: 'plugin.mjs', executables: ['bin/' + binary], kind: 'plugin', mode: 'plugin',
            config: { entrypoint: 'plugin.mjs' },
            upstream: { plugin: SNIP_PLUGIN_VERSION, cli: SNIP_VERSION, archiveSha256: sha256 } };
    } finally { await fs.rm(unpacked, { recursive: true, force: true }); }
}
