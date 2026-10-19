import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectBindingId, projectFolder, projectInstanceId, safeTarget } from './workspace.js';
import { hash, stateDir } from './state.js';
import { CONFIG_PATHS } from './installation-files.js';
import { LEDGER_PATH } from './installation-ledger.js';
import { sameValue, type Receipt } from './installation-receipt.js';
import { InventoryReader, InventoryReadError, inventoryRelative } from './project-inventory-reader.js';
import { parseProjectConfig } from './project-inventory-config.js';
import { inventoryDigest, saveInventoryScan } from './project-inventory-storage.js';
import type { InventoryEntry, InventoryKind, PrivateInventoryScan, ProjectInventory } from './project-inventory.model.js';
export type { ProjectInventory, InventoryEntry } from './project-inventory.model.js';

const SHA = /^[a-f0-9]{64}$/;
const receiptDirectory = '.opencode/neurocenter/receipts';
interface KnownReceipt { key: string; receipt: Receipt }
/** Только проектные каталоги и JSONC: глобальный профиль и исполняемый код не читаются. */
export async function scanProjectInventory(projectId: string, authorize: () => Promise<unknown>): Promise<ProjectInventory> {
    await authorize();
    const root = await projectFolder(projectId); const bindingId = await projectBindingId(projectId); const instanceId = await projectInstanceId(projectId);
    const now = new Date(); const summary: ProjectInventory = { schemaVersion: 1, projectId, bindingId, instanceId, scanId: randomUUID(), digest: '',
        checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15 * 60000).toISOString(), complete: true, issues: [], entries: [] };
    const reader = new InventoryReader(root); const selectors: Record<string, string> = {};
    const issue = (code: string): void => { summary.complete = false; if (!summary.issues.includes(code)) { summary.issues.push(code); } };
    const add = (kind: InventoryKind, relative: string, state: InventoryEntry['state'], reason: string, selector?: string): InventoryEntry | undefined => {
        if (summary.entries.length >= 200) { issue('entry-limit'); return; }
        const entry = { candidateId: randomUUID(), kind, path: relative, state, reason };
        summary.entries.push(entry); if (selector !== undefined) { selectors[entry.candidateId] = selector; } return entry;
    };
    const problem = (kind: InventoryKind, relative: string, error: unknown): void => {
        const reason = error instanceof InventoryReadError ? error.reason : 'read-failed'; issue(reason);
        add(kind, relative, reason === 'unsafe-path' ? 'unsafe' : 'unreadable', reason);
    };
    const receipts: KnownReceipt[] = []; let receiptInvalid = false; let ledgerInvalid = false;
    let ledgerRefs: Array<{ key: string; version: number; manifest: string }> = [];
    const configs = new Map<string, Record<string, unknown>>();
    try {
        for (const target of [await safeTarget(root, '.opencode/neurocenter/files.lock'), path.join(stateDir(), 'file-changes', hash(root), 'pending.json'), path.join(stateDir(), 'file-changes', hash(root), 'recovery.lock')]) {
            try { await fs.lstat(target); issue('project-busy'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { issue('project-busy'); } }
        }
        if (!summary.complete) { throw new Error(); }
        try {
            for (const name of await reader.list(receiptDirectory) ?? []) {
                if (!/^[a-f0-9]{24}\.json$/.test(name)) { receiptInvalid = true; issue('receipt-invalid'); continue; }
                const raw = await reader.read(receiptDirectory + '/' + name, 256 * 1024);
                const receipt = JSON.parse(raw!.toString('utf8')) as Receipt;
                if (!receipt || !Number.isSafeInteger(receipt.version) || receipt.version < 1 || !SHA.test(receipt.manifest)
                    || !receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files) || Object.keys(receipt.files).length > 100
                    || Object.entries(receipt.files).some(([relative, sha]) => !inventoryRelative(relative) || !SHA.test(sha))) { throw new Error(); }
                receipts.push({ key: name.slice(0, -5), receipt });
            }
        } catch { receiptInvalid = true; issue('receipt-invalid'); }
        try {
            const raw = await reader.read(LEDGER_PATH, 4 * 1048576);
            if (raw) {
                const data = JSON.parse(raw.toString('utf8')) as { schemaVersion: number; roots: Record<string, { packages: typeof ledgerRefs }> };
                if (data.schemaVersion !== 1 || !data.roots || typeof data.roots !== 'object' || Array.isArray(data.roots) || Object.keys(data.roots).length > 1000) { throw new Error(); }
                ledgerRefs = Object.values(data.roots).flatMap(item => item.packages);
                if (ledgerRefs.some(item => !item || !/^[a-f0-9]{24}$/.test(item.key) || !SHA.test(item.manifest) || !Number.isSafeInteger(item.version))) { throw new Error(); }
            }
        } catch { ledgerInvalid = true; issue('receipt-invalid'); }
        for (const relative of CONFIG_PATHS) {
            try {
                const bytes = await reader.read(relative); if (bytes) { configs.set(relative, parseProjectConfig(bytes.toString('utf8'))); }
            } catch (error) { issue(error instanceof InventoryReadError ? error.reason : 'config-invalid'); add('unknown', relative, error instanceof InventoryReadError && error.reason === 'unsafe-path' ? 'unsafe' : 'unreadable', error instanceof InventoryReadError ? error.reason : 'config-invalid'); }
        }
        const stateFor = (known: KnownReceipt | undefined, files: string[]): Pick<InventoryEntry, 'state' | 'reason'> => {
            if (!known) { return receiptInvalid ? { state: 'damaged', reason: 'receipt-invalid' } : { state: 'unmanaged', reason: 'unmanaged-files' }; }
            const { receipt, key } = known;
            if (receiptInvalid || ledgerInvalid || !ledgerRefs.some(item => item.key === key && item.version === receipt.version && item.manifest === receipt.manifest)) { return { state: 'damaged', reason: 'receipt-invalid' }; }
            const snapshots = new Map(reader.values().map(item => [item.relative, item.sha256]));
            if (!sameValue([...files].sort(), Object.keys(receipt.files).sort()) || files.some(file => snapshots.get(file) !== receipt.files[file])) { return { state: 'damaged', reason: 'file-mismatch' }; }
            if (receipt.config) {
                const config = configs.get(receipt.config.path);
                if (!config || (receipt.config.key === 'plugin' ? !Array.isArray(config.plugin) || config.plugin.filter(value => sameValue(value, receipt.config!.value)).length !== 1
                    : !sameValue((config.mcp as Record<string, unknown> | undefined)?.[receipt.config.key], receipt.config.value))) { return { state: 'damaged', reason: 'config-mismatch' }; }
            }
            return { state: 'managed', reason: 'managed-receipt' };
        };
        for (const [relative, kind] of [['.opencode/skills', 'skill'], ['.opencode/mcp-bundles', 'mcp'], ['.opencode/plugin-bundles', 'plugin']] as const) {
            try {
                for (const name of await reader.list(relative) ?? []) {
                    if (summary.entries.length >= 200) { issue('entry-limit'); break; }
                    const base = relative + '/' + name;
                    try {
                        const files = await reader.tree(base);
                        const known = receipts.find(item => kind === 'skill' ? Object.keys(item.receipt.files).some(file => file.startsWith(base + '/')) : item.key === name);
                        const state = !known && kind !== 'skill' && ledgerRefs.some(item => item.key === name)
                            ? { state: 'damaged' as const, reason: 'receipt-missing' } : stateFor(known, files); add(kind, base, state.state, state.reason);
                    } catch (error) { problem(kind, base, error); }
                }
            } catch (error) { problem(kind, relative, error); }
        }
        for (const key of new Set(ledgerRefs.map(item => item.key))) {
            if (!receipts.some(item => item.key === key)) { add('unknown', receiptDirectory + '/' + key + '.json', 'damaged', 'receipt-missing'); }
        }
        for (const relative of ['.opencode/plugins', '.opencode/plugin']) {
            try {
                for (const name of await reader.list(relative) ?? []) {
                    if (summary.entries.length >= 200) { issue('entry-limit'); break; }
                    const child = relative + '/' + name;
                    try {
                        const stat = await fs.lstat(await safeTarget(root, child));
                        if (stat.isDirectory()) { await reader.tree(child); } else { await reader.read(child); }
                        add('plugin', child, 'unmanaged', 'unknown-layout');
                    } catch (error) { problem('plugin', child, error); }
                }
            } catch (error) { problem('plugin', relative, error); }
        }
        for (const [relative, config] of configs) {
            const mcp = config.mcp as Record<string, unknown> | undefined;
            for (const key of Object.keys(mcp ?? {})) {
                if (key.length + 4 > 2048) {
                    issue('read-limit'); add('mcp', relative, 'unreadable', 'read-limit');
                    if (summary.entries.length >= 200) { issue('entry-limit'); break; }
                    continue;
                }
                const known = receipts.find(item => item.receipt.config?.path === relative && item.receipt.config.key === key);
                const valid = known && sameValue(known.receipt.config!.value, mcp![key]);
                const state = valid ? stateFor(known, Object.keys(known.receipt.files)) : { state: known ? 'damaged' as const : 'unmanaged' as const, reason: known ? 'config-mismatch' : 'unmanaged-config' };
                add('mcp', relative, state.state, state.reason, 'mcp:' + key);
                if (summary.entries.length >= 200) { issue('entry-limit'); break; }
            }
            const plugins = config.plugin as unknown[] ?? [];
            for (let index = 0; index < plugins.length && summary.entries.length < 200; index++) {
                const known = receipts.find(item => item.receipt.config?.path === relative && item.receipt.config.key === 'plugin' && sameValue(item.receipt.config.value, plugins[index]));
                const state = known ? stateFor(known, Object.keys(known.receipt.files)) : { state: 'unmanaged' as const, reason: 'unmanaged-config' };
                add('plugin', relative, state.state, state.reason, 'plugin:' + index);
                if (summary.entries.length >= 200 && index < plugins.length - 1) { issue('entry-limit'); }
            }
        }
        await reader.verify();
    } catch (error) { issue(summary.issues.includes('project-busy') ? 'project-busy' : error instanceof InventoryReadError ? error.reason : 'read-failed'); }
    await authorize();
    try { if (await projectFolder(projectId) !== root || await projectBindingId(projectId) !== bindingId || await projectInstanceId(projectId) !== instanceId) { issue('binding-changed'); } }
    catch { issue('binding-changed'); }
    summary.issues.sort();
    const scan: PrivateInventoryScan = { schemaVersion: 1, root, summary, snapshots: reader.values(), selectors };
    summary.digest = inventoryDigest(scan); await saveInventoryScan(scan); return summary;
}
