import { randomUUID } from 'node:crypto';
import { hash } from './state.js';
import { projectFolder, projectBindingId, projectInstanceId } from './workspace.js';
import { CONFIG_PATHS, commitChanges, withProjectFiles } from './installation-files.js';
import { assetBase, assetKey, legacyMcpConfigKey, mcpConfigKey, sameValue } from './installation-receipt.js';
import { packageRef, sortedRefs, type InstallSet } from './install-set.js';
import type { Package } from './package.js';
import { validateChanges } from './installation-journal.js';
import { InventoryReader } from './project-inventory-reader.js';
import { readInventoryScan } from './project-inventory-storage.js';
import { expectedAdoptConnection } from './project-inventory-config.js';
import { adoptionPlan, frozenAdoption } from './adopt-installation-plan.js';
import {
    localChangeFiles,
    localChangeDigest,
    localChangeHtml,
    readLocalChangePlan,
    saveLocalChangePlan,
    verifyLocalChangeSnapshot,
} from './local-change-plan-storage.js';
import type { ApplyLocalChangeOptions, LocalChangeSummary, PrivateLocalChangePlan } from './local-change-plan.model.js';
import type { AdoptCandidateOptions } from './project-inventory.model.js';

type Authorize = () => Promise<unknown>;
type Progress = (percent: number, message: string) => Promise<unknown>;
async function assertIdentity(projectId: string, root: string, bindingId: string, instanceId: string): Promise<void> {
    if (
        (await projectFolder(projectId)) !== root ||
        (await projectBindingId(projectId)) !== bindingId ||
        (await projectInstanceId(projectId)) !== instanceId ||
        (await projectFolder(projectId)) !== root
    ) {
        throw new Error('Привязка или экземпляр папки изменились. Повторите инвентаризацию.');
    }
}
const fresh = (checkedAt: string, expiresAt: string): void => {
    if (Date.now() > Date.parse(expiresAt) || Date.parse(checkedAt) > Date.now() + 5000) {
        throw new Error('Срок снимка истёк. Повторите инвентаризацию и подготовку.');
    }
};
/** Готовит принятие точного локального совпадения: исходные файлы и подключения не переписываются. */
export async function prepareAdoptInstallation(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    options: AdoptCandidateOptions,
    authorize: Authorize,
): Promise<LocalChangeSummary> {
    options = structuredClone(options);
    const frozen = frozenAdoption(pkg, set);
    pkg = frozen.root;
    await authorize();
    const scan = await readInventoryScan(options.scanId);
    const inventory = scan.summary;
    const candidate = inventory.entries.find((entry) => entry.candidateId === options.candidateId);
    if (
        inventory.projectId !== projectId ||
        inventory.digest !== options.digest ||
        !inventory.complete ||
        !candidate ||
        candidate.state !== 'unmanaged' ||
        candidate.kind !== pkg.plugin.kind ||
        ![assetBase(pkg), ...CONFIG_PATHS].includes(candidate.path)
    ) {
        throw new Error('Кандидат не подходит для точного принятия. Повторите инвентаризацию.');
    }
    fresh(inventory.checkedAt, inventory.expiresAt);
    return withProjectFiles(projectId, async (root) => {
        if (root !== scan.root) {
            throw new Error('Папка проекта изменилась.');
        }
        await assertIdentity(projectId, root, inventory.bindingId, inventory.instanceId);
        await new InventoryReader(root).verify(scan.snapshots);
        const prepared = await adoptionPlan(root, frozen);
        if (CONFIG_PATHS.includes(candidate.path)) {
            const selector = scan.selectors[candidate.candidateId];
            const config = prepared.configs.get(candidate.path);
            if (
                !config ||
                (pkg.plugin.kind === 'mcp'
                    ? selector !== 'mcp:' + mcpConfigKey(pkg) && selector !== 'mcp:' + legacyMcpConfigKey(pkg)
                    : !selector?.startsWith('plugin:') ||
                      !sameValue(
                          (config.plugin as unknown[] | undefined)?.[Number(selector.slice(7))],
                          expectedAdoptConnection(root, pkg),
                      ))
            ) {
                throw new Error('Выбранное подключение не соответствует одобренному инструменту.');
            }
        }
        const changes = prepared.plan.changes();
        validateChanges(changes);
        await authorize();
        fresh(inventory.checkedAt, inventory.expiresAt);
        await assertIdentity(projectId, root, inventory.bindingId, inventory.instanceId);
        await new InventoryReader(root).verify(scan.snapshots);
        await prepared.plan.verifySnapshot();
        await prepared.reader.verify();
        const checkedAt = new Date();
        const summary: LocalChangeSummary = {
            schemaVersion: 1,
            planId: randomUUID(),
            revision: 1,
            digest: '',
            projectId,
            bindingId: inventory.bindingId,
            instanceId: inventory.instanceId,
            assetId: pkg.plugin.id,
            assetKind: pkg.plugin.kind as LocalChangeSummary['assetKind'],
            version: pkg.plugin.version,
            manifest: pkg.manifest.sha256,
            checkedAt: checkedAt.toISOString(),
            expiresAt: new Date(checkedAt.getTime() + 15 * 60000).toISOString(),
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
            snapshots: prepared.plan.snapshotFingerprints(),
            reportSha256: '',
            purpose: 'adopt',
            sourceId: options.candidateId,
        };
        const html = localChangeHtml(saved);
        saved.reportSha256 = hash(html);
        summary.digest = localChangeDigest(saved);
        await saveLocalChangePlan(saved, html);
        return summary;
    });
}

/** После отдельного разрешения атомарно создаёт только metadata и сохраняет исходные байты без изменений. */
export async function applyAdoptInstallation(
    projectId: string,
    pkg: Package,
    options: ApplyLocalChangeOptions,
    authorize: Authorize,
    progress: Progress,
) {
    options = structuredClone(options);
    const frozen = frozenAdoption(pkg, options.installSet);
    pkg = frozen.root;
    const saved = await readLocalChangePlan(options.planId);
    const summary = saved.summary;
    if (
        saved.purpose !== 'adopt' ||
        !saved.sourceId ||
        projectId !== summary.projectId ||
        options.revision !== 1 ||
        options.digest !== summary.digest ||
        options.expectedBindingId !== summary.bindingId ||
        !sameValue(packageRef(pkg), {
            kind: summary.assetKind,
            id: summary.assetId,
            version: summary.version,
            manifest: summary.manifest,
        }) ||
        frozen.manifest !== saved.installationManifest ||
        !sameValue(sortedRefs(frozen.packages), saved.packages)
    ) {
        throw new Error('Подтверждение не соответствует плану принятия.');
    }
    fresh(summary.checkedAt, summary.expiresAt);
    await authorize();
    return withProjectFiles(projectId, async (root) => {
        if (root !== saved.root) {
            throw new Error('Папка проекта изменилась после сравнения.');
        }
        const assertCurrent = async (): Promise<void> => {
            fresh(summary.checkedAt, summary.expiresAt);
            await assertIdentity(projectId, root, summary.bindingId, summary.instanceId);
            await verifyLocalChangeSnapshot(saved);
            const current = await adoptionPlan(root, frozen);
            if (
                !sameValue(current.plan.changes(), saved.changes) ||
                !sameValue(
                    [...current.plan.snapshotFingerprints()].sort((a, b) => (a.relative < b.relative ? -1 : 1)),
                    [...saved.snapshots].sort((a, b) => (a.relative < b.relative ? -1 : 1)),
                )
            ) {
                throw new Error('Локальная установка изменилась после сравнения. Подготовьте план заново.');
            }
            await current.reader.verify();
            await assertIdentity(projectId, root, summary.bindingId, summary.instanceId);
        };
        await assertCurrent();
        await progress(35, 'Точное совпадение проверено; ожидается подтверждение принятия');
        await authorize();
        await assertCurrent();
        const result = {
            projectId,
            assetId: pkg.plugin.id,
            version: pkg.plugin.version,
            bindingId: summary.bindingId,
            manifest: frozen.manifest,
            files: frozen.packages.reduce((count, member) => count + member.files.length, 0),
            changed: saved.changes.length > 0,
            ...(options.installSet ? { packages: saved.packages } : {}),
            readiness: 'unverified',
            changePlanId: summary.planId,
            digest: summary.digest,
            note: 'Точные локальные файлы приняты под управление без изменения исходников и подключений; запуск ещё не проверен.',
        };
        const recoveryPath = await commitChanges(
            root,
            saved.changes,
            { action: 'install', assetKey: assetKey(pkg), manifest: frozen.manifest, result },
            { verifySnapshot: assertCurrent },
        );
        return { ...result, recoveryPath };
    });
}
