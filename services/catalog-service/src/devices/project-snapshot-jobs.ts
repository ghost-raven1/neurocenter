import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Device, DeviceStore } from './device-store';
import { managedBinding, assertExpectedBinding } from './device-compatibility';
import type { JobInput } from './device-job.model';

export const SNAPSHOT_JOB_KIND = 'publish-project-snapshot';
/** Snapshot jobs are bound to an existing durable publication and cannot choose another local folder. */
export async function projectSnapshotPayload(
    store: DeviceStore,
    device: Device,
    input: JobInput,
): Promise<Record<string, unknown> | undefined> {
    if (input.kind !== SNAPSHOT_JOB_KIND) return;
    if (typeof input.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.snapshotId))
        throw new BadRequestException('Нужна сохранённая публикация снимка.');
    const bindingId = managedBinding(device.report, input.projectId);
    assertExpectedBinding(bindingId, input.expectedBindingId, true);
    const request = await store.pool.query(
        'SELECT 1 FROM project_snapshots WHERE id=$1 AND email=$2 AND request_key::text=$3',
        [input.snapshotId, device.email, input.requestKey],
    );
    if (!request.rowCount) throw new ConflictException('UUID задания должен совпадать с исходным запросом публикации.');
    const payload = { snapshotId: input.snapshotId, bindingId, snapshotProtocol: 'project-snapshots-v1' };
    await assertProjectSnapshotJob(store, device, { project_id: input.projectId!, payload });
    return payload;
}
export async function assertProjectSnapshotJob(
    store: DeviceStore,
    device: Device,
    job: { project_id: string | null; payload: Record<string, unknown> },
): Promise<void> {
    if (
        job.payload.snapshotProtocol !== 'project-snapshots-v1' ||
        !Array.isArray(device.report.capabilities) ||
        !device.report.capabilities.includes('project-snapshots-v1') ||
        device.report.ragSupported === false ||
        managedBinding(device.report, job.project_id ?? undefined) !== job.payload.bindingId
    )
        throw new ConflictException('Обновите мост и проверьте привязку папки перед публикацией снимка.');
    const { rows } = await store.pool.query(
        "SELECT 1 FROM project_snapshots WHERE id=$1 AND project_id=$2 AND email=$3 AND device_id=$4 AND binding_id=$5 AND (status IN ('UPLOADING','VERIFYING','VERIFIED') OR upload_completed_at IS NOT NULL)",
        [job.payload.snapshotId, job.project_id, device.email, device.id, job.payload.bindingId],
    );
    if (!rows.length) throw new ConflictException('Публикация снимка отменена или её владелец изменился.');
}
