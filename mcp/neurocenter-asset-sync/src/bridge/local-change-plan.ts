import { randomUUID } from 'node:crypto';
import { hash } from './state.js';
import { verify, type Package } from './package.js';
import { projectFolder, projectBindingId, projectInstanceId } from './workspace.js';
import { InstallationPlan } from './installation-plan.js';
import { InstallationLedger } from './installation-ledger.js';
import { planInstall } from './installation-planner.js';
import { resolvePreparedRuntimeArtifact, selectedRuntimeArtifact } from '../features/runtime-artifacts/cache.js';
import { assetBase, assetKey, sameValue } from './installation-receipt.js';
import { commitChanges, withProjectFiles } from './installation-files.js';
import { packageDependencies, packageRef, sortedRefs, verifyInstallSet, type InstallSet } from './install-set.js';
import { validateChanges } from './installation-journal.js';
import {
    localChangeFiles,
    localChangeDigest,
    localChangeHtml,
    readLocalChangePlan,
    saveLocalChangePlan,
    verifyLocalChangeSnapshot,
} from './local-change-plan-storage.js';
import type { ApplyLocalChangeOptions, LocalChangeSummary, PrivateLocalChangePlan } from './local-change-plan.model.js';
export { localChangeReportPath } from './local-change-plan-storage.js';
export type { ApplyLocalChangeOptions, LocalChangeSummary } from './local-change-plan.model.js';

type Authorize = () => Promise<unknown>;
type Progress = (percent: number, message: string) => Promise<unknown>;
function frozenPackages(
    pkg: Package,
    set: InstallSet | undefined,
): { root: Package; packages: Package[]; manifest: string } {
    pkg = structuredClone(pkg);
    set = set ? structuredClone(set) : undefined;
    verify(pkg);
    if (set) {
        verifyInstallSet(set);
        if (!sameValue(set.root, packageRef(pkg))) {
            throw new Error('Корневой пакет не совпадает с закреплённым набором.');
        }
        const refs = sortedRefs(set.packages);
        return {
            root: pkg,
            packages: refs.map((ref) =>
                set.packages.find((member) => member.plugin.kind === ref.kind && member.plugin.id === ref.id)!,
            ),
            manifest: set.manifest,
        };
    }
    if (packageDependencies(pkg).length) {
        throw new Error('Для восстановления зависимостей нужен полный закреплённый набор.');
    }
    return { root: pkg, packages: [pkg], manifest: pkg.manifest.sha256 };
}
async function assertIdentity(projectId: string, root: string, bindingId: string, instanceId: string): Promise<void> {
    if (
        (await projectFolder(projectId)) !== root ||
        (await projectBindingId(projectId)) !== bindingId ||
        (await projectInstanceId(projectId)) !== instanceId ||
        (await projectFolder(projectId)) !== root
    ) {
        throw new Error('Привязка или экземпляр папки изменились. Подготовьте сравнение заново.');
    }
}

/** Сохраняет локальный полный diff; безопасный результат не содержит исходников, секретов и абсолютных путей. */
export async function prepareLocalChange(
    projectId: string,
    pkg: Package,
    installSet: InstallSet | undefined,
    authorize: Authorize,
): Promise<LocalChangeSummary> {
    const frozen = frozenPackages(pkg, installSet);
    pkg = frozen.root;
    return withProjectFiles(projectId, async (root) => {
        const bindingId = await projectBindingId(projectId);
        const instanceId = await projectInstanceId(projectId);
        const plan = new InstallationPlan(root);
        const ledger = await InstallationLedger.load(plan);
        const bases = new Set<string>();
        const key = assetKey(pkg);
        for (const member of frozen.packages) {
            const base = assetBase(member).normalize('NFC').toLowerCase();
            if (bases.has(base)) {
                throw new Error('Конфликт путей разных пакетов набора.');
            }
            bases.add(base);
            ledger.assertInstall(key, member);
        }
        const runtimeRepairs = new Set<Package>();
        for (const member of frozen.packages) {
            if (!selectedRuntimeArtifact(member)) {
                continue;
            }
            try {
                await resolvePreparedRuntimeArtifact(member);
            } catch {
                runtimeRepairs.add(member);
            }
        }
        for (const member of frozen.packages) {
            await planInstall(plan, member, { repair: true, runtimeRepairPreview: runtimeRepairs.has(member) });
        }
        await ledger.install(packageRef(pkg), frozen.manifest, frozen.packages);
        const changes = plan.changes();
        validateChanges(changes);
        if (changes.some((change) => change.relative.length > 1024)) {
            throw new Error('Слишком длинный путь для безопасного сравнения.');
        }
        await authorize();
        await assertIdentity(projectId, root, bindingId, instanceId);
        await plan.verifySnapshot();
        const checkedAt = new Date();
        const summary: LocalChangeSummary = {
            schemaVersion: 1,
            planId: randomUUID(),
            revision: 1,
            digest: '',
            projectId,
            bindingId,
            instanceId,
            assetId: pkg.plugin.id,
            assetKind: pkg.plugin.kind as LocalChangeSummary['assetKind'],
            version: pkg.plugin.version,
            manifest: pkg.manifest.sha256,
            checkedAt: checkedAt.toISOString(),
            expiresAt: new Date(checkedAt.getTime() + 15 * 60000).toISOString(),
            status: 'prepared',
            files: localChangeFiles(changes),
            ...(runtimeRepairs.size ? { runtimeRepairRequired: true as const } : {}),
        };
        const saved: PrivateLocalChangePlan = {
            schemaVersion: 1,
            summary,
            root,
            installationManifest: frozen.manifest,
            packages: sortedRefs(frozen.packages),
            changes,
            snapshots: plan.snapshotFingerprints(),
            reportSha256: '',
        };
        const html = localChangeHtml(saved);
        saved.reportSha256 = hash(html);
        summary.digest = localChangeDigest(saved);
        await saveLocalChangePlan(saved, html);
        return summary;
    });
}

/** Применяет ровно просмотренный снимок после нового разрешения; резервная копия хранит ручной вариант. */
export async function applyLocalChange(
    projectId: string,
    pkg: Package,
    options: ApplyLocalChangeOptions,
    authorize: Authorize,
    progress: Progress,
    prepareRuntime?: (packages: Package[]) => Promise<void>,
) {
    const frozen = frozenPackages(pkg, options.installSet);
    pkg = frozen.root;
    const saved = await readLocalChangePlan(options.planId);
    const summary = saved.summary;
    if (
        saved.purpose !== undefined ||
        options.revision !== 1 ||
        options.digest !== summary.digest ||
        options.expectedBindingId !== summary.bindingId ||
        projectId !== summary.projectId ||
        !sameValue(packageRef(pkg), {
            kind: summary.assetKind,
            id: summary.assetId,
            version: summary.version,
            manifest: summary.manifest,
        }) ||
        frozen.manifest !== saved.installationManifest ||
        !sameValue(sortedRefs(frozen.packages), saved.packages)
    ) {
        throw new Error('Подтверждение не соответствует локальному плану. Подготовьте сравнение заново.');
    }
    const assertFresh = () => {
        if (Date.now() > Date.parse(summary.expiresAt) || Date.parse(summary.checkedAt) > Date.now() + 5000) {
            throw new Error('Срок локального плана истёк. Подготовьте сравнение заново.');
        }
    };
    assertFresh();
    return withProjectFiles(projectId, async (root) => {
        if (root !== saved.root) {
            throw new Error('Папка проекта изменилась после сравнения.');
        }
        const assertCurrent = async () => {
            assertFresh();
            await assertIdentity(projectId, root, summary.bindingId, summary.instanceId);
            await verifyLocalChangeSnapshot(saved);
        };
        await assertCurrent();
        await progress(35, 'Снимок сравнения проверен; ожидается подтверждение восстановления');
        await authorize();
        await assertCurrent();
        if (summary.runtimeRepairRequired) {
            if (!prepareRuntime) {
                throw new Error('Подтверждённое восстановление готового кэша требует повторной загрузки через мост.');
            }
            await prepareRuntime(frozen.packages);
            await authorize();
            await assertCurrent();
        }
        for (const member of frozen.packages) {
            await resolvePreparedRuntimeArtifact(member);
        }
        const result = {
            projectId,
            assetId: pkg.plugin.id,
            version: pkg.plugin.version,
            bindingId: summary.bindingId,
            manifest: frozen.manifest,
            files: frozen.packages.reduce((count, member) => count + member.files.length, 0),
            changed: saved.changes.length > 0 || !!summary.runtimeRepairRequired,
            ...(options.installSet ? { packages: saved.packages } : {}),
            readiness: 'unverified',
            changePlanId: summary.planId,
            digest: summary.digest,
            note: 'Просмотренные изменения применены. Ручной вариант сохранён в закрытой резервной копии; запуск инструмента ещё не проверен.',
        };
        const recoveryPath = await commitChanges(
            root,
            saved.changes,
            {
                action: 'install',
                assetKey: assetKey(pkg),
                manifest: frozen.manifest,
                result,
                recovery: {
                    schemaVersion: 1,
                    projectId,
                    instanceId: summary.instanceId,
                    bindingId: summary.bindingId,
                    asset: packageRef(pkg),
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
