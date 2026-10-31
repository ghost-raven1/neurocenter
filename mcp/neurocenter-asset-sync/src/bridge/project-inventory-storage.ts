import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalV4 } from './package.js';
import { hash, stateDir } from './state.js';
import { atomicText } from './atomic-file.js';
import { readBoundedUtf8 } from './read-bounded.js';
import { recoveryDirectory, withRecoveryBudget } from './installation-space.js';
import { inventoryRelative } from './project-inventory-reader.js';
import type { PrivateInventoryScan } from './project-inventory.model.js';

export const INVENTORY_REASONS = [
    'managed-receipt',
    'managed-project-learning',
    'unmanaged-files',
    'unmanaged-config',
    'receipt-invalid',
    'receipt-missing',
    'file-mismatch',
    'config-mismatch',
    'config-invalid',
    'unsafe-path',
    'read-failed',
    'read-limit',
    'snapshot-changed',
    'entry-limit',
    'project-busy',
    'binding-changed',
    'unknown-layout',
] as const;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const directory = () => path.join(stateDir(), 'project-inventory');
export function inventoryDigest(scan: PrivateInventoryScan): string {
    const { digest: _digest, ...summary } = scan.summary;
    return hash(JSON.stringify(canonicalV4({ ...scan, summary })));
}
function validate(scan: PrivateInventoryScan): void {
    const item = scan?.summary;
    if (
        !scan ||
        scan.schemaVersion !== 1 ||
        !path.isAbsolute(scan.root) ||
        !item ||
        item.schemaVersion !== 1 ||
        !UUID.test(item.scanId) ||
        !SHA.test(item.digest) ||
        !SHA.test(item.bindingId) ||
        !UUID.test(item.instanceId) ||
        typeof item.projectId !== 'string' ||
        !item.projectId ||
        item.projectId.length > 500 ||
        typeof item.complete !== 'boolean' ||
        !Array.isArray(item.entries) ||
        item.entries.length > 200 ||
        !Array.isArray(item.issues) ||
        item.issues.length > INVENTORY_REASONS.length ||
        item.issues.some((code) => !INVENTORY_REASONS.includes(code as (typeof INVENTORY_REASONS)[number])) ||
        new Date(item.checkedAt).toISOString() !== item.checkedAt ||
        new Date(item.expiresAt).toISOString() !== item.expiresAt ||
        Date.parse(item.expiresAt) - Date.parse(item.checkedAt) !== 15 * 60000 ||
        Buffer.byteLength(JSON.stringify(item)) > 512 * 1024 ||
        item.entries.some(
            (entry) =>
                !entry ||
                !UUID.test(entry.candidateId) ||
                !inventoryRelative(entry.path) ||
                !['skill', 'mcp', 'plugin', 'unknown'].includes(entry.kind) ||
                !['managed', 'unmanaged', 'damaged', 'unsafe', 'unreadable'].includes(entry.state) ||
                !INVENTORY_REASONS.includes(entry.reason as (typeof INVENTORY_REASONS)[number]),
        ) ||
        new Set(item.entries.map((entry) => entry.candidateId)).size !== item.entries.length ||
        !scan.selectors ||
        typeof scan.selectors !== 'object' ||
        Array.isArray(scan.selectors) ||
        Object.entries(scan.selectors).some(
            ([id, selector]) =>
                !item.entries.some((entry) => entry.candidateId === id) ||
                typeof selector !== 'string' ||
                selector.length > 2048,
        ) ||
        !Array.isArray(scan.snapshots) ||
        scan.snapshots.length > 2000 ||
        scan.snapshots.some(
            (snapshot) =>
                !inventoryRelative(snapshot.relative) ||
                !['file', 'directory'].includes(snapshot.type) ||
                (snapshot.fingerprint === null) !== (snapshot.sha256 === null) ||
                (snapshot.fingerprint !== null &&
                    (!/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(snapshot.fingerprint) || !SHA.test(snapshot.sha256!))),
        ) ||
        inventoryDigest(scan) !== item.digest
    ) {
        throw new Error('Некорректный снимок инвентаризации.');
    }
}
/** Снимки закрыты, ограничены 64 МиБ на текущий hub и не удаляются автоматически. */
export async function saveInventoryScan(scan: PrivateInventoryScan): Promise<void> {
    validate(scan);
    const text = JSON.stringify(scan);
    if (Buffer.byteLength(text) > 2 * 1048576) {
        throw new Error('Снимок инвентаризации слишком большой.');
    }
    await withRecoveryBudget(scan.root, Math.ceil(Buffer.byteLength(text) / 2), [], false, async () => {
        await recoveryDirectory(directory());
        let bytes = 0;
        let count = 0;
        for await (const entry of await fs.opendir(directory())) {
            const stat = await fs.lstat(path.join(directory(), entry.name));
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error('Небезопасное хранилище инвентаризации.');
            }
            bytes += stat.size;
            if (++count >= 1000) {
                throw new Error('Достигнут лимит снимков инвентаризации.');
            }
        }
        if (bytes + Buffer.byteLength(text) > 64 * 1048576) {
            throw new Error('Снимки инвентаризации достигли лимита 64 МиБ. Перенесите старые снимки вручную.');
        }
        const destination = path.join(directory(), scan.summary.scanId + '.json');
        try {
            await fs.lstat(destination);
            throw new Error('Снимок уже существует.');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        await atomicText(destination, text, 0o600);
    });
}
export async function readInventoryScan(scanId: string): Promise<PrivateInventoryScan> {
    try {
        if (!UUID.test(scanId)) {
            throw new Error();
        }
        await recoveryDirectory(directory(), false);
        const scan = JSON.parse(
            await readBoundedUtf8(path.join(directory(), scanId + '.json'), 2 * 1048576),
        ) as PrivateInventoryScan;
        validate(scan);
        if (scan.summary.scanId !== scanId) {
            throw new Error();
        }
        return scan;
    } catch {
        throw new Error('Снимок инвентаризации отсутствует, повреждён или изменён. Повторите проверку.');
    }
}
