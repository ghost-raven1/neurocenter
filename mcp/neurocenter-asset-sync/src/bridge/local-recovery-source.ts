import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, stateDir } from './state.js';
import { readBoundedUtf8 } from './read-bounded.js';
import { recoveryDirectory } from './installation-space.js';
import { journalDirectory, parseJournal } from './installation-journal.js';
import { readLocalChangePlan } from './local-change-plan-storage.js';
import { assetKey, sameValue } from './installation-receipt.js';
import { packageRef, sortedRefs } from './install-set.js';
import { variantIndexDirectory, type RecoveryIndex } from './local-recovery-index.js';
import type { RecoveryContext } from './local-recovery-context.js';
import type { RecoverySource, LocalVariantReason } from './local-recovery.model.js';
import type { PrivateLocalChangePlan } from './local-change-plan.model.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MAX_BYTES = 64 * 1048576;

/** Чтение ограничено общим бюджетом; повреждённые записи не превращаются в разрешение на запись. */
export async function recoverySources(
    context: RecoveryContext,
): Promise<{ sources: RecoverySource[]; complete: boolean }> {
    let used = 0;
    let entries = 0;
    let complete = true;
    const sources = new Map<string, RecoverySource>();
    const roots = new Set([context.root]);
    const verifiedPlans = new Map<string, PrivateLocalChangePlan>();
    const read = async (file: string, maximum = MAX_BYTES): Promise<string> => {
        const stat = await fs.lstat(file);
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > maximum ||
            used >= MAX_BYTES ||
            used + stat.size > MAX_BYTES
        ) {
            complete = false;
            throw new Error();
        }
        used += stat.size;
        return readBoundedUtf8(file, Math.min(maximum, MAX_BYTES - used + stat.size));
    };
    const loadPlan = async (id: string): Promise<PrivateLocalChangePlan> => {
        if (!UUID.test(id)) {
            throw new Error();
        }
        const cached = verifiedPlans.get(id);
        if (cached) {
            return cached;
        }
        const file = path.join(stateDir(), 'local-change-plans', id + '.json');
        const stat = await fs.lstat(file);
        if (used + 2 * stat.size > MAX_BYTES) {
            complete = false;
            throw new Error();
        }
        const raw = await read(file);
        used += stat.size;
        try {
            const plan = await readLocalChangePlan(id);
            if (!sameValue(JSON.parse(raw), plan)) {
                throw new Error();
            }
            verifiedPlans.set(id, plan);
            return plan;
        } catch {
            used = MAX_BYTES;
            complete = false;
            throw new Error();
        }
    };
    const names = async (directory: string): Promise<string[]> => {
        try {
            await recoveryDirectory(directory, false);
            const found: string[] = [];
            for await (const entry of await fs.opendir(directory)) {
                if (++entries > 1000) {
                    complete = false;
                    break;
                }
                found.push(entry.name);
            }
            return found;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                complete = false;
            }
            return [];
        }
    };
    const add = async (root: string, id: string, claimedDate?: string, claimedHash?: string) => {
        if (sources.has(id) || !UUID.test(id) || sources.size >= 200) {
            if (sources.size >= 200) {
                complete = false;
            }
            return;
        }
        const file = path.join(journalDirectory(root), 'history', id + '.json');
        try {
            await recoveryDirectory(path.dirname(file), false);
            const raw = await read(file);
            const journal = parseJournal(raw, root);
            if (
                journal.id !== id ||
                journal.assetKey !== assetKey(context.pkg) ||
                journal.state !== 'committed' ||
                journal.action !== 'install'
            ) {
                return;
            }
            let reason: LocalVariantReason = 'legacy-unverified';
            let createdAt = (await fs.lstat(file)).mtime.toISOString();
            if (journal.recovery) {
                const descriptor = journal.recovery;
                createdAt = descriptor.createdAt;
                reason =
                    descriptor.projectId !== context.projectId || descriptor.instanceId !== context.instanceId
                        ? 'different-instance'
                        : descriptor.installationManifest !== context.manifest ||
                            !sameValue(descriptor.asset, packageRef(context.pkg)) ||
                            !sameValue(descriptor.packages, sortedRefs(context.packages))
                          ? 'different-installation'
                          : 'ready';
            } else if (typeof journal.result?.changePlanId === 'string' && typeof journal.result.digest === 'string') {
                try {
                    const plan = await loadPlan(journal.result.changePlanId);
                    if (
                        plan.purpose !== undefined ||
                        plan.summary.digest !== journal.result.digest ||
                        plan.root !== journal.root ||
                        !sameValue(plan.changes, journal.changes) ||
                        journal.manifest !== plan.installationManifest ||
                        journal.result.projectId !== plan.summary.projectId ||
                        journal.result.assetId !== plan.summary.assetId ||
                        journal.result.version !== plan.summary.version ||
                        journal.result.bindingId !== plan.summary.bindingId ||
                        journal.result.manifest !== plan.installationManifest
                    ) {
                        throw new Error();
                    }
                    createdAt = plan.summary.checkedAt;
                    reason =
                        plan.summary.projectId !== context.projectId || plan.summary.instanceId !== context.instanceId
                            ? 'different-instance'
                            : plan.installationManifest !== context.manifest ||
                                !sameValue(plan.packages, sortedRefs(context.packages)) ||
                                !sameValue(
                                    {
                                        kind: plan.summary.assetKind,
                                        id: plan.summary.assetId,
                                        version: plan.summary.version,
                                        manifest: plan.summary.manifest,
                                    },
                                    packageRef(context.pkg),
                                )
                              ? 'different-installation'
                              : 'ready';
                } catch {
                    reason = 'legacy-unverified';
                }
            }
            if (
                (claimedDate && createdAt !== claimedDate) ||
                (journal.recovery && reason === 'ready' && (!claimedHash || hash(raw) !== claimedHash))
            ) {
                reason = 'invalid-backup';
            }
            sources.set(id, { journal, createdAt, reason });
        } catch {
            complete = false;
        }
    };
    const index = variantIndexDirectory(context.instanceId);
    for (const name of await names(index)) {
        if (!name.startsWith(assetKey(context.pkg) + '-') || !name.endsWith('.index.json')) {
            continue;
        }
        try {
            const value = JSON.parse(await read(path.join(index, name), 16384)) as RecoveryIndex;
            if (
                !value ||
                value.schemaVersion !== 1 ||
                !UUID.test(value.recoveryId) ||
                value.assetKey !== assetKey(context.pkg) ||
                name !== value.assetKey + '-' + value.recoveryId + '.index.json' ||
                typeof value.journalRoot !== 'string' ||
                !path.isAbsolute(value.journalRoot) ||
                !/^[a-f0-9]{64}$/.test(value.journalSha256)
            ) {
                throw new Error();
            }
            await add(value.journalRoot, value.recoveryId, value.createdAt, value.journalSha256);
        } catch {
            complete = false;
        }
    }
    // Старый private plan доказывает прежний root после rename; имена папок не угадываются.
    const plans = path.join(stateDir(), 'local-change-plans');
    for (const name of await names(plans)) {
        const id = name.slice(0, -5);
        if (!name.endsWith('.json') || !UUID.test(id)) {
            continue;
        }
        try {
            const plan = await loadPlan(id);
            if (
                plan.summary.projectId === context.projectId &&
                plan.summary.instanceId === context.instanceId &&
                plan.summary.assetId === context.pkg.plugin.id &&
                plan.summary.assetKind === context.pkg.plugin.kind
            ) {
                roots.add(plan.root);
            }
        } catch {
            /* Неподтверждённый private plan не расширяет область поиска. */
        }
    }
    for (const root of roots) {
        const directory = path.join(journalDirectory(root), 'history');
        for (const name of await names(directory)) {
            if (name.endsWith('.json')) {
                await add(root, name.slice(0, -5));
            }
        }
    }
    const ordered = [...sources.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.journal.id.localeCompare(b.journal.id),
    );
    if (ordered.length > 100) {
        complete = false;
    }
    return { sources: ordered.slice(0, 100), complete };
}
