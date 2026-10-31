import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
    PROJECT_CONFIGURATION_JOB,
    PROJECT_CONFIGURATION_CAPABILITY,
    normalizeProjectConfigurationSession,
} from '../../../shared/project-configuration.cjs';
import { requiredJobFeatures } from '../../../shared/feature-policy.cjs';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { assertExpectedBinding, managedBinding } from './device-compatibility';
import { assertLocalFeature } from './local-change-jobs';
import type { Device, DeviceStore } from './device-store';
import { localRagUi } from '../../../shared/rag-ui-contract.cjs';
import type { DeviceInstallations } from './device-installations';
import type { Job, JobInput } from './device-job.model';
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
function currentBinding(device: Device, projectId: string, expectedBindingId: unknown, expectedInstanceId: unknown) {
    assertLocalFeature(device.report, PROJECT_CONFIGURATION_CAPABILITY);
    const bindingId = managedBinding(device.report, projectId);
    assertExpectedBinding(bindingId, expectedBindingId, true);
    const binding = (
        device.report.bindings as Array<{ projectId: string; bindingId?: string; instanceId?: string; valid?: boolean }>
    ).find((item) => item.projectId === projectId && item.bindingId === bindingId && item.valid !== false);
    if (!uuid(expectedInstanceId) || binding?.instanceId !== expectedInstanceId)
        throw new ConflictException('Экземпляр папки изменился. Откройте мастер заново.');
    return { bindingId, instanceId: expectedInstanceId };
}
async function ragReferences(installations: DeviceInstallations, device: Device, projectId: string, bindingId: string) {
    const packages = await installations.workspacePackages(device.email, device.id, projectId, bindingId);
    return packages
        .filter((pkg) => {
            try {
                return !!localRagUi(pkg);
            } catch {
                return false;
            }
        })
        .map((pkg) => ({
            kind: pkg.plugin.kind,
            id: pkg.plugin.id,
            version: pkg.plugin.version,
            manifest: pkg.manifest.sha256,
        }));
}
/** The website supplies a pinned binding, never paths, text, configuration values or credentials. */
export async function projectConfigurationPayload(installations: DeviceInstallations, device: Device, input: JobInput) {
    if (input.kind !== PROJECT_CONFIGURATION_JOB) return;
    const allowed = ['deviceId', 'projectId', 'kind', 'requestKey', 'expectedBindingId', 'expectedInstanceId'];
    if (Object.keys(input).some((key) => !allowed.includes(key)) || !input.projectId)
        throw new BadRequestException('Мастер принимает только идентификаторы проекта и папки.');
    const identity = currentBinding(device, input.projectId, input.expectedBindingId, input.expectedInstanceId);
    return {
        descriptor: normalizeProjectConfigurationSession({
            schemaVersion: 1,
            deviceId: device.id,
            projectId: input.projectId,
            ...identity,
            ragInstallations: await ragReferences(installations, device, input.projectId, identity.bindingId),
            sessionId: randomUUID(),
            expiresAt: new Date(Date.now() + 900000).toISOString(),
        }),
        ...identity,
    };
}
export async function assertProjectConfigurationJob(
    installations: DeviceInstallations,
    device: Device,
    job: Pick<Job, 'kind' | 'payload' | 'project_id'>,
) {
    if (job.kind !== PROJECT_CONFIGURATION_JOB) return;
    let d;
    try {
        d = normalizeProjectConfigurationSession(job.payload.descriptor);
    } catch {
        throw new ConflictException('Контекст мастера повреждён.');
    }
    if (
        d.deviceId !== device.id ||
        d.projectId !== job.project_id ||
        job.payload.bindingId !== d.bindingId ||
        job.payload.instanceId !== d.instanceId ||
        Date.parse(d.expiresAt) <= Date.now() ||
        Date.parse(d.expiresAt) > Date.now() + 900000
    )
        throw new ConflictException('Срок или контекст мастера изменились.');
    const current = currentBinding(device, d.projectId, d.bindingId, d.instanceId);
    if (current.bindingId !== d.bindingId || current.instanceId !== d.instanceId)
        throw new ConflictException('Папка мастера изменилась.');
    if (!isDeepStrictEqual(await ragReferences(installations, device, d.projectId, d.bindingId), d.ragInstallations))
        throw new ConflictException('Установка RAG изменилась. Откройте мастер заново.');
    return d;
}
/** Standalone permits survive opening ACK but recheck current admin rights, TTL, device and feature flags. */
export async function authorizeProjectConfiguration(
    store: DeviceStore,
    installations: DeviceInstallations,
    device: Device,
    input: unknown,
    permission: (role: string, projectId: string) => Promise<unknown>,
) {
    const body = input as { jobId?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !uuid(body.jobId))
        throw new BadRequestException('Разрешение принимает только исходное задание открытия.');
    const job = (
        await store.pool.query<Job>(
            `SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3 AND kind=$4 AND state IN ('running','succeeded')`,
            [body.jobId, device.id, device.email, PROJECT_CONFIGURATION_JOB],
        )
    ).rows[0];
    if (!job || !job.project_id) throw new ConflictException('Мастер не открыт этим компьютером.');
    await permission(job.role, job.project_id);
    const descriptor = (await assertProjectConfigurationJob(installations, device, job))!;
    const current = await store.pool.query<{ payload: Record<string, unknown> }>(
        `SELECT job.payload FROM bridge_jobs job JOIN bridge_devices device ON device.id=job.device_id
        WHERE job.id=$1 AND job.device_id=$2 AND job.email=$3 AND job.role=$4 AND job.kind=$5
        AND job.state IN ('running','succeeded') AND job.payload->'descriptor'=$6::jsonb
        AND (job.payload->'descriptor'->>'expiresAt')::timestamptz>clock_timestamp()
        AND device.email=$3 AND device.role=$7 AND NOT device.revoked AND device.expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM projects WHERE id=job.project_id)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(device.report->'bindings') binding WHERE binding->>'projectId'=job.project_id
            AND binding->>'bindingId'=$8 AND binding->>'instanceId'=$9 AND binding->>'valid' IS DISTINCT FROM 'false')`,
        [
            job.id,
            device.id,
            device.email,
            job.role,
            PROJECT_CONFIGURATION_JOB,
            JSON.stringify(descriptor),
            device.role,
            descriptor.bindingId,
            descriptor.instanceId,
        ],
    );
    if (!current.rows.length || !isDeepStrictEqual(current.rows[0].payload.descriptor, descriptor))
        throw new ConflictException('Мастер отозван, истёк или папка изменилась. Черновик остался на компьютере.');
    await permission(job.role, job.project_id);
    await requireFeaturesEnabled(requiredJobFeatures(PROJECT_CONFIGURATION_JOB, job.payload, true));
    return { ok: true };
}
