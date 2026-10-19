import fs from 'node:fs/promises';
import path from 'node:path';
import { assetBase, assetKey } from '../src/bridge/installation-receipt.js';
import { expectedAdoptConnection } from '../src/bridge/project-inventory-config.js';
import { parseProjectConfig } from '../src/bridge/project-inventory-config.js';
import { scanProjectInventory } from '../src/bridge/project-inventory.js';
import { prepareAdoptInstallation } from '../src/bridge/adopt-installation.js';
import type { Package } from '../src/bridge/package.js';
import type { InstallSet } from '../src/bridge/install-set.js';

export const noop = async () => undefined;
/** Тестовые исходники существуют заранее; принятие не вызывает обычную установку. */
export async function unmanaged(root: string, pkg: Package): Promise<void> {
    for (const file of pkg.files) {
        const target = path.join(root, assetBase(pkg), file.path); await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.from(file.content, file.encoding ?? 'utf8'));
    }
    if (pkg.plugin.kind === 'skill') { return; }
    const destination = path.join(root, 'opencode.jsonc');
    const raw = await fs.readFile(destination, 'utf8').catch(() => '{}'); const config = parseProjectConfig(raw);
    if (pkg.plugin.kind === 'mcp') { config.mcp = { ...config.mcp as object, ['neurocenter_' + assetKey(pkg)]: expectedAdoptConnection(root, pkg) }; }
    else { config.plugin = [...config.plugin as unknown[] ?? [], expectedAdoptConnection(root, pkg)]; }
    await fs.writeFile(destination, '// Комментарий должен остаться\n' + JSON.stringify(config, null, 2) + '\n');
}
export async function adoptPreview(root: string, pkg: Package, set?: InstallSet) {
    const scan = await scanProjectInventory('test-project', noop);
    const entry = scan.entries.find(item => item.path === assetBase(pkg)); if (!entry) { throw new Error('Нет кандидата: ' + JSON.stringify(scan)); }
    const summary = await prepareAdoptInstallation('test-project', pkg, set, { scanId: scan.scanId, candidateId: entry.candidateId, digest: scan.digest }, noop);
    return { scan, entry, summary };
}
export async function bytesAndTimes(root: string, pkg: Package): Promise<unknown> {
    const paths = [...pkg.files.map(file => assetBase(pkg) + '/' + file.path), ...(pkg.plugin.kind === 'skill' ? [] : ['opencode.jsonc'])];
    return Promise.all(paths.map(async relative => {
        const file = path.join(root, relative); const stat = await fs.stat(file, { bigint: true });
        return { relative, bytes: (await fs.readFile(file)).toString('base64'), inode: stat.ino.toString(), mtime: stat.mtimeNs.toString() };
    }));
}
