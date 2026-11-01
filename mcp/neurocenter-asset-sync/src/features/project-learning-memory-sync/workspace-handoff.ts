import path from 'node:path';
import { hub, stateDir } from '../../bridge/state.js';
import { syncDirectory } from '../../bridge/atomic-file.js';
import type { IPackage } from '../../bridge/package.js';
import type { IWorkspaceBindingResult, IWorkspaceFileVerification } from '../../bridge/workspace-instance.model.js';
import { readPrivateConfiguration, writePrivateConfiguration } from '../local-configuration/private-store.js';
import { memoryDigest, memoryNamespace, memoryRecipeSupported } from './contract.js';
import { assertProjectionJournal, type IProjectionJournal } from './projection.js';
import { journalKey } from './receipts.js';

/** Only verified current installation identity enters the workspace recovery journal; learned text stays private. */
export interface IMemoryOwnershipHandoff {
    schemaVersion: 1;
    site: string;
    projectId: string;
    instanceId: string;
    previousBindingId: string;
    bindingId: string;
    assetId: string;
    version: number;
    manifest: string;
    sourceDigest: string;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = [
    'schemaVersion',
    'site',
    'projectId',
    'instanceId',
    'previousBindingId',
    'bindingId',
    'assetId',
    'version',
    'manifest',
    'sourceDigest',
];
const conflict = () =>
    new Error('Журнал владения Memory изменился или принадлежит другой привязке. Перенос остановлен.');
const sourceKey = (item: IMemoryOwnershipHandoff) =>
    journalKey(item.site, { ...item, bindingId: item.previousBindingId });
const targetKey = (item: IMemoryOwnershipHandoff) => journalKey(item.site, item);
const retired = (item: IMemoryOwnershipHandoff) => ({
    schemaVersion: 1,
    kind: 'memory-ownership-transferred',
    targetKey: targetKey(item),
    handoffDigest: memoryDigest(item),
});
const equal = (left: unknown, right: unknown) =>
    left !== undefined && right !== undefined && memoryDigest(left) === memoryDigest(right);

/** Recovery accepts no arbitrary private keys, cross-site namespaces, or changes of instance. */
export function assertMemoryOwnershipHandoffs(
    value: unknown,
    result: IWorkspaceBindingResult,
): asserts value is IMemoryOwnershipHandoff[] {
    if (
        !Array.isArray(value) ||
        value.length > 20 ||
        (value.length && (!['resume', 'transfer'].includes(result.mode) || !result.previousBindingId))
    )
        throw conflict();
    const assets = new Set<string>();
    for (const item of value) {
        if (
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            Object.keys(item).length !== keys.length ||
            keys.some((key) => !Object.hasOwn(item, key)) ||
            item.schemaVersion !== 1 ||
            item.site !== hub() ||
            item.projectId !== result.projectId ||
            item.instanceId !== result.instanceId ||
            item.previousBindingId !== result.previousBindingId ||
            item.bindingId !== result.bindingId ||
            item.previousBindingId === item.bindingId ||
            !sha(item.previousBindingId) ||
            !sha(item.bindingId) ||
            !sha(item.manifest) ||
            !sha(item.sourceDigest) ||
            !Number.isSafeInteger(item.version) ||
            item.version < 1 ||
            typeof item.assetId !== 'string' ||
            !item.assetId ||
            item.assetId.length > 512 ||
            /[\x00-\x1f\x7f]/.test(item.assetId) ||
            assets.has(item.assetId)
        )
            throw conflict();
        assets.add(item.assetId);
    }
}
function journal(value: unknown, item: IMemoryOwnershipHandoff): IProjectionJournal {
    assertProjectionJournal(value as IProjectionJournal, memoryNamespace(item.site, item.projectId));
    if (memoryDigest(value) !== item.sourceDigest) throw conflict();
    return value as IProjectionJournal;
}

/** Called under identity and installation locks after both roots match the same frozen package. */
export async function prepareMemoryOwnershipHandoffs(
    context: IWorkspaceFileVerification,
    packages: IPackage[],
): Promise<IMemoryOwnershipHandoff[]> {
    if (!['resume', 'transfer'].includes(context.mode)) return [];
    const memories = packages.filter(memoryRecipeSupported);
    if (!memories.length) return [];
    if (!context.previousBindingId || !context.bindingId || !context.instanceId) throw conflict();
    const result: IMemoryOwnershipHandoff[] = [];
    for (const pkg of memories) {
        const identity = {
            schemaVersion: 1 as const,
            site: hub(),
            projectId: context.projectId,
            instanceId: context.instanceId,
            previousBindingId: context.previousBindingId,
            bindingId: context.bindingId,
            assetId: pkg.plugin.id,
            version: pkg.plugin.version,
            manifest: pkg.manifest.sha256,
        };
        const before = await readPrivateConfiguration<IProjectionJournal>(sourceKey({ ...identity, sourceDigest: '' }));
        if (before === undefined) continue;
        assertProjectionJournal(before, memoryNamespace(identity.site, identity.projectId));
        const item = { ...identity, sourceDigest: memoryDigest(before) };
        if ((await readPrivateConfiguration(targetKey(item))) !== undefined) throw conflict();
        result.push(item);
    }
    return result;
}

/** Before committing identity, require the same source snapshot and an unoccupied destination. */
export async function assertPreparedMemoryOwnership(items: IMemoryOwnershipHandoff[]): Promise<void> {
    for (const item of items) {
        journal(await readPrivateConfiguration(sourceKey(item)), item);
        if ((await readPrivateConfiguration(targetKey(item))) !== undefined) throw conflict();
    }
}

/** Committed recovery copies the full uncertain plan, then retires the old CAS key; never invokes MCP. */
export async function finishMemoryOwnershipHandoffs(items: IMemoryOwnershipHandoff[]): Promise<void> {
    for (const item of items) {
        const source = await readPrivateConfiguration(sourceKey(item)),
            target = await readPrivateConfiguration(targetKey(item)),
            tombstone = retired(item);
        if (equal(source, tombstone)) {
            journal(target, item);
            continue;
        }
        const snapshot = journal(source, item);
        if (target !== undefined) journal(target, item);
        else {
            await writePrivateConfiguration(targetKey(item), snapshot, undefined);
            await syncDirectory(path.join(stateDir(), 'local-configuration'));
        }
        await writePrivateConfiguration(sourceKey(item), tombstone, source);
        await syncDirectory(path.join(stateDir(), 'local-configuration'));
    }
}
