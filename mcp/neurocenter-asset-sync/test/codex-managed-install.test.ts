import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { install, installSet } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { InstallationPlan } from '../src/bridge/installation-plan.js';
import { planInstall, type PlanInstallOptions } from '../src/bridge/installation-planner.js';
import { LEDGER_PATH } from '../src/bridge/installation-ledger.js';
import { assetBase, assetKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { prepareLocalChange } from '../src/bridge/local-change-plan.js';
import { codexFixture } from './opencode-provider-codex.fixture.js';
import { noop } from './opencode-provider.fixture.js';
import { rehashPackage, setFixture, setPackage } from './install-set-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
const manualConfig = '// KEEP manual configuration\n{"model":"manual/default","plugin":["manual-plugin"]}\n';
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(remove => remove()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

async function fixture() {
    const f = await codexFixture();
    cleanup.push(f.cleanup);
    await fs.writeFile(path.join(f.root, 'opencode.jsonc'), manualConfig);
    return f;
}

/** Includes private receipts/reports and cache bytes, so rejected operations cannot leave a hidden plan. */
async function snapshot(root: string): Promise<Record<string, { bytes: string; modified: number }>> {
    const result: Record<string, { bytes: string; modified: number }> = {};
    for (const relative of (await fs.readdir(root, { recursive: true })).sort()) {
        const file = path.join(root, relative), stat = await fs.lstat(file);
        if (stat.isFile()) { result[relative] = { bytes: (await fs.readFile(file)).toString('base64'), modified: stat.mtimeMs }; }
    }
    return result;
}

/** Reproduces the old direct URL install using the real installer, before the connector became managed. */
async function legacyInstallation() {
    const f = await fixture();
    const previous = structuredClone(f.pkg);
    delete previous.config!.extra!.codexConnector;
    rehashPackage(previous);
    await install(f.descriptor.projectId, previous, noop, noop);
    const receiptFile = path.join(f.root, receiptPath(f.pkg));
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    receipt.manifest = f.pkg.manifest.sha256;
    await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
    const ledgerFile = path.join(f.root, LEDGER_PATH);
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    const root = ledger.roots[assetKey(f.pkg)];
    root.manifest = f.pkg.manifest.sha256;
    root.root.manifest = f.pkg.manifest.sha256;
    for (const member of root.packages) { member.manifest = f.pkg.manifest.sha256; }
    await fs.writeFile(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
    const directUrl = pathToFileURL(f.resolution.entrypoint).href;
    expect(receipt.config).toEqual({ path: 'opencode.jsonc', key: 'plugin', value: directUrl });
    expect(parse(await fs.readFile(path.join(f.root, 'opencode.jsonc'), 'utf8')).plugin).toEqual(['manual-plugin', directUrl]);
    return { ...f, directUrl };
}

describe('Managed Codex connector cannot use generic plugin installation', () => {
    it.each<[string, PlanInstallOptions]>([
        ['install', {}],
        ['repair', { repair: true }],
        ['runtime repair preview', { repair: true, runtimeRepairPreview: true }],
    ])('rejects planner %s before reading or changing the installation plan', async (_operation, options) => {
        const f = await fixture(), plan = new InstallationPlan(f.root);
        const before = await snapshot(f.temporary);

        await expect(planInstall(plan, f.pkg, options)).rejects.toThrow('Настроить в OpenCode');

        expect(plan.changes()).toEqual([]);
        expect(plan.snapshotFingerprints()).toEqual([]);
        expect(await snapshot(f.temporary)).toEqual(before);
    });

    it('rejects application installation before authorization, configuration, receipts or cache changes', async () => {
        const f = await fixture(), before = await snapshot(f.temporary), authorize = vi.fn(noop), progress = vi.fn(noop);

        await expect(install(f.descriptor.projectId, f.pkg, authorize, progress)).rejects.toThrow('Настроить в OpenCode');

        expect(authorize).not.toHaveBeenCalled();
        expect(progress).not.toHaveBeenCalled();
        expect(await snapshot(f.temporary)).toEqual(before);
    });

    it('rejects a complete installation set containing the managed connector without committing an ordinary parent', async () => {
        const f = await fixture(), parent = setPackage('a-ordinary-parent', 'plugin', 1, [f.pkg]);
        const before = await snapshot(f.temporary), authorize = vi.fn(noop), progress = vi.fn(noop);

        await expect(installSet(f.descriptor.projectId, setFixture(parent, [f.pkg]), authorize, progress)).rejects.toThrow('Настроить в OpenCode');

        expect(authorize).not.toHaveBeenCalled();
        expect(progress).not.toHaveBeenCalled();
        expect(await snapshot(f.temporary)).toEqual(before);
        await expect(fs.access(path.join(f.root, assetBase(parent), 'index.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('still installs and inspects an ordinary plugin with Codex in its name', async () => {
        const f = await fixture(), pkg = setPackage('ordinary-codex-plugin', 'plugin'), authorize = vi.fn(noop);

        expect(await install(f.descriptor.projectId, pkg, authorize, noop)).toMatchObject({ changed: true, readiness: 'unverified' });

        expect(authorize).toHaveBeenCalledOnce();
        expect(parse(await fs.readFile(path.join(f.root, 'opencode.jsonc'), 'utf8')).plugin).toEqual([
            'manual-plugin', pathToFileURL(path.join(f.root, assetBase(pkg), 'index.mjs')).href,
        ]);
        expect(await inspectInstallation(f.descriptor.projectId, pkg)).toMatchObject({ state: 'checked', status: 'synced', issues: [] });
    });

    it('preserves an existing direct URL, receipt and ledger when install or repair is refused', async () => {
        const f = await legacyInstallation(), before = await snapshot(f.temporary), authorize = vi.fn(noop);
        const plan = new InstallationPlan(f.root);

        await expect(install(f.descriptor.projectId, f.pkg, authorize, noop)).rejects.toThrow('Настроить в OpenCode');
        await expect(planInstall(plan, f.pkg, { repair: true })).rejects.toThrow('Настроить в OpenCode');
        await expect(prepareLocalChange(f.descriptor.projectId, f.pkg, undefined, authorize)).rejects.toThrow('Настроить в OpenCode');

        expect(authorize).not.toHaveBeenCalled();
        expect(plan.changes()).toEqual([]);
        expect(plan.snapshotFingerprints()).toEqual([]);
        expect(await snapshot(f.temporary)).toEqual(before);
    });

    it('inspects a legacy direct URL as modified without writes and still permits its proven uninstall', async () => {
        const f = await legacyInstallation(), before = await snapshot(f.temporary), cacheBefore = await snapshot(f.resolution.root);

        expect(await inspectInstallation(f.descriptor.projectId, f.pkg)).toMatchObject({
            state: 'checked', status: 'modified', readiness: 'unverified', issues: ['config-modified'],
        });
        expect(await snapshot(f.temporary)).toEqual(before);

        const result = await uninstall(f.descriptor.projectId, f.pkg, noop, noop);
        expect(result).toMatchObject({ changed: true, manifest: f.pkg.manifest.sha256 });
        const source = await fs.readFile(path.join(f.root, 'opencode.jsonc'), 'utf8');
        expect(source).toContain('// KEEP manual configuration');
        expect(parse(source)).toEqual({ model: 'manual/default', plugin: ['manual-plugin'] });
        await expect(fs.access(path.join(f.root, receiptPath(f.pkg)))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.parse(await fs.readFile(path.join(f.root, LEDGER_PATH), 'utf8')).roots[assetKey(f.pkg)]).toBeUndefined();
        expect(await snapshot(f.resolution.root)).toEqual(cacheBefore);
        expect(JSON.parse(await fs.readFile(result.recoveryPath, 'utf8')).state).toBe('committed');
    });
});
