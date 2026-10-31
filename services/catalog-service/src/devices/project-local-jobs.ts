import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Device, DeviceStore } from './device-store';
import type { DeviceInstallations } from './device-installations';
import type { InstallPlans } from './install-plans';
import type { JobInput } from './device-jobs';
import { managedBinding, assertExpectedBinding, assertPackageBridge } from './device-compatibility';
import { assertLocalFeature } from './local-change-jobs';
import { assertLocalChangePlan } from './local-change-plan';
import { assertProjectInventory, uuid, sha, relativePath } from './project-local-reports';
import { localCapability, localPurpose, PROJECT_LOCAL_KINDS, PROJECT_LOCAL_APPLIES } from './project-local-actions';
import type { IPackage } from '../catalog/bundle-package';
import type { IInstallationSet } from './installation-set';

interface SourceJob {
    id: string;
    device_id: string;
    project_id: string | null;
    email: string;
    role?: string;
    kind: string;
    payload: Record<string, unknown>;
}
type Payload = Record<string, unknown> & { package?: IPackage; installSet?: IInstallationSet };
const conflict = () =>
    new ConflictException('План истёк или относится к другой папке, версии либо действию. Подготовьте его заново.');
function identity(device: Device, input: { projectId?: string; expectedBindingId?: string }) {
    const bindingId = managedBinding(device.report, input.projectId);
    assertExpectedBinding(bindingId, input.expectedBindingId, true);
    const binding = (device.report.bindings as Array<{ projectId: string; instanceId?: string }>).find(
        (item) => item.projectId === input.projectId,
    );
    if (!uuid(binding?.instanceId)) throw new ConflictException('Подтвердите экземпляр папки проекта.');
    return { bindingId, instanceId: binding.instanceId };
}
async function inventorySource(store: DeviceStore, device: Device, projectId: string, payload: Payload) {
    if (
        !uuid(payload.inventoryJobId) ||
        !uuid(payload.scanId) ||
        !uuid(payload.candidateId) ||
        !sha(payload.expectedInventoryDigest)
    )
        throw conflict();
    const { rows } = await store.pool.query(
        `SELECT result FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND project_id=$3
        AND email=$4 AND kind='scan-project-inventory' AND state='succeeded'`,
        [payload.inventoryJobId, device.id, projectId, device.email],
    );
    const result: unknown = rows[0]?.result;
    assertProjectInventory(result, { projectId, bindingId: payload.bindingId, instanceId: payload.instanceId });
    if (
        !result.complete ||
        result.scanId !== payload.scanId ||
        result.digest !== payload.expectedInventoryDigest ||
        Date.parse(result.expiresAt) <= Date.now() ||
        Date.parse(result.checkedAt) > Date.now() + 5000 ||
        !result.entries.some((entry) => entry.candidateId === payload.candidateId && entry.state === 'unmanaged')
    )
        throw conflict();
}
async function savedPlan(store: DeviceStore, device: Device, input: JobInput) {
    if (!uuid(input.changePlanId) || input.changePlanRevision !== 1 || !sha(input.expectedChangeDigest))
        throw new BadRequestException('Выберите подготовленный план, его ревизию и SHA.');
    const { rows } = await store.pool.query(
        `SELECT p.*,j.payload AS source_payload FROM bridge_local_change_plans p
        JOIN bridge_jobs j ON j.id=p.preparation_job_id WHERE p.id=$1 AND p.device_id=$2 AND p.project_id=$3 AND p.email=$4
        AND p.expires_at>now() AND p.applied_job_id IS NULL`,
        [input.changePlanId, device.id, input.projectId, device.email],
    );
    const plan = rows[0];
    if (!plan || plan.digest !== input.expectedChangeDigest || plan.revision !== input.changePlanRevision)
        throw conflict();
    return plan;
}

/** Новые действия используют текущую привязку и сохранённый одобренный комплект, без обращения к head. */
export async function projectLocalJobPayload(
    store: DeviceStore,
    installations: DeviceInstallations,
    plans: InstallPlans,
    device: Device,
    input: JobInput,
): Promise<Payload | undefined> {
    if (!PROJECT_LOCAL_KINDS.includes(input.kind) && input.kind !== 'open-local-change-report') return;
    const saved =
        input.kind === 'open-local-change-report' || PROJECT_LOCAL_APPLIES.includes(input.kind)
            ? await savedPlan(store, device, input)
            : undefined;
    if (input.kind === 'open-local-change-report' && (saved?.purpose ?? 'repair') === 'repair') return;
    const purpose = saved ? (saved.purpose ?? 'repair') : localPurpose(input.kind);
    if (saved && !['repair', 'adopt', 'restore-local'].includes(purpose)) throw conflict();
    if (PROJECT_LOCAL_APPLIES.includes(input.kind) && purpose !== localPurpose(input.kind)) throw conflict();
    const effectiveKind =
        input.kind === 'open-local-change-report'
            ? purpose === 'adopt'
                ? 'apply-adopt-installation'
                : 'apply-local-restore'
            : input.kind;
    assertLocalFeature(device.report, localCapability(effectiveKind));
    if (input.kind === 'scan-opencode-models') {
        if (device.role !== 'Главный админ' || !['global', 'project'].includes(String(input.scope)))
            throw new BadRequestException(
                'Выберите общий или проектный источник OpenCode на компьютере главного администратора.',
            );
        if (
            Object.keys(input).some(
                (key) =>
                    ![
                        'deviceId',
                        'kind',
                        'requestKey',
                        'scope',
                        ...(input.scope === 'project' ? ['projectId', 'expectedBindingId'] : []),
                    ].includes(key),
            )
        )
            throw new BadRequestException('Передайте только выбранный источник OpenCode и его привязку.');
        if (input.scope === 'global') {
            if (input.projectId !== undefined || input.expectedBindingId !== undefined)
                throw new BadRequestException('Общий источник OpenCode не относится к проектной папке.');
            return { scope: 'global', deviceId: device.id };
        }
        return { scope: 'project', ...identity(device, input) };
    }
    const tuple = identity(device, input);
    let payload: Payload = { ...tuple };
    if (input.kind === 'scan-project-inventory') return payload;
    if (purpose === 'adopt') {
        if (saved) {
            const source = saved.source_payload as Payload;
            const pkg = source.package;
            if (
                !pkg ||
                input.assetId !== pkg.plugin.id ||
                input.assetKind !== pkg.plugin.kind ||
                input.expectedManifest !== pkg.manifest.sha256
            )
                throw conflict();
            const approved = await plans.delivery(
                source.planId,
                input.projectId!,
                source.assetKind,
                source.assetId,
                source.version,
                source.planRevision,
                source.installSet?.manifest ?? pkg.manifest.sha256,
            );
            payload = { ...source, ...approved, ...tuple };
        } else {
            const approved = await plans.delivery(
                input.planId,
                input.projectId!,
                input.assetKind,
                input.assetId,
                input.version,
                input.planRevision,
                input.expectedManifest,
            );
            payload = {
                ...approved,
                ...tuple,
                planId: input.planId,
                planRevision: input.planRevision,
                inventoryJobId: input.inventoryJobId,
                scanId: input.scanId,
                candidateId: input.candidateId,
                expectedInventoryDigest: input.expectedInventoryDigest,
            };
        }
        await inventorySource(store, device, input.projectId!, payload);
    } else {
        const installed = await installations.inspectionDelivery(
            { email: device.email, activeRole: device.role },
            { ...input, bindingId: tuple.bindingId },
        );
        if (input.kind === 'list-local-variants') payload = { ...installed, ...tuple };
        else payload = { ...(await plans.approvedInstalled(input.projectId!, installed.package)), ...tuple };
        if (input.kind === 'prepare-local-restore') {
            if (
                !uuid(input.recoveryId) ||
                (input.restorePaths !== undefined &&
                    (!Array.isArray(input.restorePaths) ||
                        !input.restorePaths.length ||
                        input.restorePaths.length > 512 ||
                        input.restorePaths.some((value) => !relativePath(value)) ||
                        new Set(input.restorePaths).size !== input.restorePaths.length))
            )
                throw new BadRequestException('Выберите сохранённый вариант и допустимые пути.');
            payload.recoveryId = input.recoveryId;
            if (input.restorePaths) payload.restorePaths = input.restorePaths;
        }
    }
    const pkg = payload.package!;
    assertPackageBridge(device.report, pkg);
    Object.assign(payload, { assetId: pkg.plugin.id, assetKind: pkg.plugin.kind, version: pkg.plugin.version });
    if (saved) {
        assertLocalChangePlan(saved.summary, { projectId: input.projectId!, ...tuple, package: pkg });
        if (saved.binding_id !== tuple.bindingId || saved.instance_id !== tuple.instanceId) throw conflict();
        Object.assign(payload, {
            changePlanId: input.changePlanId,
            changePlanRevision: input.changePlanRevision,
            expectedChangeDigest: input.expectedChangeDigest,
            localPlanPurpose: purpose,
        });
    }
    return payload;
}

/** Проверки повторяются при выдаче и перед записью, включая срок и назначение плана. */
export async function assertProjectLocalJob(
    store: DeviceStore,
    installations: DeviceInstallations,
    plans: InstallPlans,
    device: Device,
    job: SourceJob,
): Promise<void> {
    if (!PROJECT_LOCAL_KINDS.includes(job.kind) && !job.payload.localPlanPurpose) return;
    if (job.kind === 'scan-opencode-models' && job.role !== 'Главный админ')
        throw new ConflictException('Импорт конфигурации моделей доступен главному администратору.');
    const purpose = job.payload.localPlanPurpose as string | undefined;
    const effective =
        job.kind === 'open-local-change-report'
            ? purpose === 'adopt'
                ? 'apply-adopt-installation'
                : 'apply-local-restore'
            : job.kind;
    assertLocalFeature(device.report, localCapability(effective));
    if (job.kind === 'scan-opencode-models') {
        if (device.role !== 'Главный админ') throw conflict();
        if (job.payload.scope === 'global' && job.project_id === null && job.payload.deviceId === device.id) return;
        if (job.payload.scope !== 'project' || !job.project_id) throw conflict();
    }
    const tuple = identity(device, { projectId: job.project_id!, expectedBindingId: job.payload.bindingId as string });
    if (tuple.instanceId !== job.payload.instanceId) throw conflict();
    if (['scan-project-inventory', 'scan-opencode-models'].includes(effective)) return;
    if (effective.includes('adopt')) await inventorySource(store, device, job.project_id!, job.payload);
    else {
        const pkg = await installations.inspectionPackage(
            { email: device.email, activeRole: (job.payload.role as string) || device.role },
            {
                deviceId: device.id,
                projectId: job.project_id!,
                assetId: job.payload.assetId as string,
                assetKind: job.payload.assetKind as string,
                bindingId: tuple.bindingId,
                expectedManifest: (job.payload.package as IPackage)?.manifest.sha256,
            },
        );
        if (pkg.manifest.sha256 !== (job.payload.package as IPackage)?.manifest.sha256) throw conflict();
    }
    if (effective === 'list-local-variants') return;
    const pkg = job.payload.package as IPackage;
    const set = job.payload.installSet as IInstallationSet | undefined;
    await plans.delivery(
        job.payload.planId,
        job.project_id!,
        job.payload.assetKind,
        job.payload.assetId,
        job.payload.version,
        job.payload.planRevision,
        set?.manifest ?? pkg.manifest.sha256,
    );
    if (PROJECT_LOCAL_APPLIES.includes(effective)) {
        const { rows } = await store.pool.query(
            `SELECT 1 FROM bridge_local_change_plans WHERE id=$1 AND device_id=$2 AND project_id=$3 AND email=$4
            AND binding_id=$5 AND instance_id=$6 AND digest=$7 AND revision=$8 AND purpose=$9 AND expires_at>now() AND applied_job_id IS NULL`,
            [
                job.payload.changePlanId,
                device.id,
                job.project_id,
                job.email,
                tuple.bindingId,
                tuple.instanceId,
                job.payload.expectedChangeDigest,
                job.payload.changePlanRevision,
                localPurpose(effective),
            ],
        );
        if (!rows.length) throw conflict();
    }
}
