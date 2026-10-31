import { randomUUID } from 'node:crypto';
import { hash } from './state.js';
import type { Package } from './package.js';
import { packageRef, sortedRefs, type InstallSet } from './install-set.js';
import { assetKey, sameValue } from './installation-receipt.js';
import { commitChanges, withProjectFiles } from './installation-files.js';
import { validateChanges } from './installation-journal.js';
import { freezeRecoveryPackages, recoveryContext } from './local-recovery-context.js';
import { recoverySources } from './local-recovery-source.js';
import { recoveryTargets } from './local-recovery-changes.js';
import { LocalRecoveryError, type LocalVariantList } from './local-recovery.model.js';
import {
    localChangeDigest,
    localChangeFiles,
    localChangeHtml,
    readLocalChangePlan,
    saveLocalChangePlan,
    verifyLocalChangeSnapshot,
} from './local-change-plan-storage.js';
import type { ApplyLocalChangeOptions, LocalChangeSummary, PrivateLocalChangePlan } from './local-change-plan.model.js';
export type { LocalVariantList, LocalVariantEntry, LocalVariantReason } from './local-recovery.model.js';
type Authorize = () => Promise<unknown>;
type Progress = (percent: number, message: string) => Promise<unknown>;

/** Список содержит только метаданные копий текущего инструмента, без локального содержимого. */
export async function listLocalVariants(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    authorize: Authorize,
): Promise<LocalVariantList> {
    const frozen = freezeRecoveryPackages(pkg, set);
    return withProjectFiles(projectId, async (root) => {
        const context = await recoveryContext(projectId, root, frozen);
        const { sources, complete } = await recoverySources(context);
        const entries = [];
        for (const source of sources) {
            let reason = source.reason;
            let files = 0;
            if (reason === 'ready') {
                try {
                    files = (await recoveryTargets(context, source)).length;
                } catch (error) {
                    reason = error instanceof LocalRecoveryError ? error.reason : 'invalid-backup';
                }
            }
            entries.push({
                recoveryId: source.journal.id,
                createdAt: source.createdAt,
                files,
                eligible: reason === 'ready',
                reason,
            });
        }
        await authorize();
        await context.assertIdentity();
        await context.plan.verifySnapshot();
        return {
            schemaVersion: 1,
            projectId,
            bindingId: context.bindingId,
            instanceId: context.instanceId,
            assetId: frozen.pkg.plugin.id,
            assetKind: frozen.pkg.plugin.kind,
            version: frozen.pkg.plugin.version,
            manifest: frozen.pkg.manifest.sha256,
            checkedAt: new Date().toISOString(),
            complete,
            entries,
        };
    });
}

/** Preview никогда не применяет копию: он фиксирует выбранные пути и текущие CAS-снимки. */
export async function prepareLocalRestore(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    options: { recoveryId: string; paths?: string[] },
    authorize: Authorize,
): Promise<LocalChangeSummary> {
    const frozen = freezeRecoveryPackages(pkg, set);
    options = structuredClone(options);
    return withProjectFiles(projectId, async (root) => {
        const context = await recoveryContext(projectId, root, frozen);
        const { sources } = await recoverySources(context);
        const source = sources.find((item) => item.journal.id === options.recoveryId);
        if (!source) {
            throw new LocalRecoveryError('invalid-backup');
        }
        const targets = await recoveryTargets(context, source, options.paths);
        for (const target of targets) {
            await context.plan.write(target.relative, target.after, target.encoding);
        }
        const changes = context.plan.changes();
        validateChanges(changes);
        await authorize();
        await context.assertIdentity();
        await context.plan.verifySnapshot();
        const now = new Date();
        const summary: LocalChangeSummary = {
            schemaVersion: 1,
            planId: randomUUID(),
            revision: 1,
            digest: '',
            projectId,
            bindingId: context.bindingId,
            instanceId: context.instanceId,
            assetId: frozen.pkg.plugin.id,
            assetKind: frozen.pkg.plugin.kind as LocalChangeSummary['assetKind'],
            version: frozen.pkg.plugin.version,
            manifest: frozen.pkg.manifest.sha256,
            checkedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 15 * 60000).toISOString(),
            status: 'prepared',
            files: localChangeFiles(changes),
        };
        const saved: PrivateLocalChangePlan = {
            schemaVersion: 1,
            summary,
            root,
            installationManifest: frozen.manifest,
            packages: sortedRefs(frozen.packages),
            changes,
            snapshots: context.plan.snapshotFingerprints(),
            reportSha256: '',
            purpose: 'restore-local',
            sourceId: options.recoveryId,
        };
        const html = localChangeHtml(saved);
        saved.reportSha256 = hash(html);
        summary.digest = localChangeDigest(saved);
        await saveLocalChangePlan(saved, html);
        return summary;
    });
}

/** Применение пишет только просмотренные собственные bytes и сохраняет текущий вариант обычной транзакцией. */
export async function applyLocalRestore(
    projectId: string,
    pkg: Package,
    options: ApplyLocalChangeOptions,
    authorize: Authorize,
    progress: Progress,
) {
    const frozen = freezeRecoveryPackages(pkg, options.installSet);
    const saved = await readLocalChangePlan(options.planId);
    const summary = saved.summary;
    if (
        saved.purpose !== 'restore-local' ||
        !saved.sourceId ||
        options.revision !== 1 ||
        options.digest !== summary.digest ||
        options.expectedBindingId !== summary.bindingId ||
        projectId !== summary.projectId ||
        !sameValue(packageRef(frozen.pkg), {
            kind: summary.assetKind,
            id: summary.assetId,
            version: summary.version,
            manifest: summary.manifest,
        }) ||
        frozen.manifest !== saved.installationManifest ||
        !sameValue(sortedRefs(frozen.packages), saved.packages)
    ) {
        throw new LocalRecoveryError('different-installation');
    }
    return withProjectFiles(projectId, async (root) => {
        const context = await recoveryContext(projectId, root, frozen);
        const { sources } = await recoverySources(context);
        const source = sources.find((item) => item.journal.id === saved.sourceId);
        if (!source || source.reason !== 'ready') {
            throw new LocalRecoveryError(source?.reason ?? 'invalid-backup');
        }
        if (saved.changes.length) {
            const targets = await recoveryTargets(
                context,
                source,
                saved.changes.map((change) => change.relative),
            );
            for (const target of targets) {
                await context.plan.write(target.relative, target.after, target.encoding);
            }
            if (!sameValue(context.plan.changes(), saved.changes)) {
                throw new LocalRecoveryError('invalid-backup');
            }
        }
        const assertCurrent = async () => {
            if (
                root !== saved.root ||
                context.bindingId !== summary.bindingId ||
                context.instanceId !== summary.instanceId
            ) {
                throw new LocalRecoveryError('different-instance');
            }
            if (Date.now() > Date.parse(summary.expiresAt) || Date.parse(summary.checkedAt) > Date.now() + 5000) {
                throw new Error('Срок локального плана истёк. Подготовьте сравнение заново.');
            }
            await context.assertIdentity();
            await context.plan.verifySnapshot();
            await verifyLocalChangeSnapshot(saved);
        };
        await assertCurrent();
        await progress(35, 'Сохранённый локальный вариант проверен; ожидается подтверждение');
        await authorize();
        await assertCurrent();
        const result = {
            projectId,
            assetId: frozen.pkg.plugin.id,
            version: frozen.pkg.plugin.version,
            bindingId: summary.bindingId,
            manifest: frozen.manifest,
            files: frozen.packages.reduce((sum, member) => sum + member.files.length, 0),
            changed: saved.changes.length > 0,
            ...(options.installSet ? { packages: saved.packages } : {}),
            readiness: 'unverified',
            changePlanId: summary.planId,
            digest: summary.digest,
            note: 'Просмотренный локальный вариант восстановлен; текущие байты сохранены в закрытой копии.',
        };
        const recoveryPath = await commitChanges(
            root,
            saved.changes,
            {
                action: 'install',
                assetKey: assetKey(frozen.pkg),
                manifest: frozen.manifest,
                result,
                recovery: {
                    schemaVersion: 1,
                    projectId,
                    instanceId: summary.instanceId,
                    bindingId: summary.bindingId,
                    asset: packageRef(frozen.pkg),
                    installationManifest: frozen.manifest,
                    packages: saved.packages,
                    createdAt: new Date().toISOString(),
                },
            },
            { verifySnapshot: assertCurrent },
        );
        return { ...result, recoveryPath };
    });
}
