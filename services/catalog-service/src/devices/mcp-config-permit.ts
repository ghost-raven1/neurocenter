import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Device, DeviceStore } from './device-store';
import type { DeviceInstallations } from './device-installations';
import type { InstallPlans } from './install-plans';
import type { Job } from './device-job.model';
import { configurationUuid } from './mcp-config-reports';
import { assertMcpConfigurationJob } from './mcp-config-jobs';

/** Сессия формы переживает ACK открытия; перед записью повторяется текущая авторизация без продления TTL. */
export async function authorizeMcpConfigurationSave(
    store: DeviceStore,
    installations: DeviceInstallations,
    plans: InstallPlans,
    device: Device,
    input: unknown,
    permission: (role: string, projectId?: string) => Promise<unknown>,
) {
    const body = input as { jobId?: unknown } | null;
    if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !configurationUuid(body.jobId)
    )
        throw new BadRequestException('Разрешение настройки принимает только исходное задание открытия.');
    const { rows } = await store.pool.query<Job>(
        `SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3
        AND kind='open-mcp-configuration' AND state IN ('running','succeeded')`,
        [body.jobId, device.id, device.email],
    );
    const job = rows[0];
    if (!job) throw new ConflictException('Сессия настройки закрыта или не принадлежит этому компьютеру.');
    await permission(job.role, job.project_id ?? undefined);
    await assertMcpConfigurationJob(store, installations, plans, device, job);
    const updated = await store.pool.query(
        `UPDATE bridge_jobs SET payload=jsonb_set(payload,'{configurationInvalidatedAt}',COALESCE(payload->'configurationInvalidatedAt',to_jsonb(clock_timestamp())))
        WHERE id=$1 AND device_id=$2 AND email=$3 AND state IN ('running','succeeded')
        AND (payload->>'configurationExpiresAt')::timestamptz>clock_timestamp()
        AND EXISTS(SELECT 1 FROM bridge_devices active_device WHERE active_device.id=$2 AND active_device.email=$3 AND active_device.role=$4
            AND NOT active_device.revoked AND active_device.expires_at>clock_timestamp()) RETURNING id`,
        [job.id, device.id, device.email, device.role],
    );
    if (!updated.rowCount) throw new ConflictException('Сессия настройки была отменена.');
    return { ok: true };
}
