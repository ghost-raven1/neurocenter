import { ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { projectLevel, roleLevel, type IAccessClaims } from '../access/access.model';
import { OPENCODE_CLI_INSPECT_JOB } from '../../../shared/computer-setup.cjs';
import { OPENCODE_CLI_INSTALL_JOB } from '../../../shared/opencode-cli-install.cjs';
import {
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB,
} from '../../../shared/opencode-local-providers.cjs';
import { configurationRead } from './mcp-config-reports';
import { PROJECT_LOCAL_READS } from './project-local-actions';
import { recordDeviceOperation } from './device-operations';
import { RUNTIME_CACHE_POLICY_JOB } from '../../../shared/runtime-cache-policy.cjs';
import { runtimeCacheWorkRole } from './runtime-cache-jobs';
import { publishMethodChatResult } from '../agent-method-workflows/chat-origin';

export const REVOKED_QUEUE_MESSAGE = 'Доступ к проекту или роль отозваны. Ожидающее задание отменено до выдачи мосту.';

/** Чтение установки не получает права записи; уровень совпадает при создании, выдаче и очистке очереди. */
export function jobMinimumLevel(kind: string): number {
    if (
        [
            'sync-learning-memory',
            'publish-project-snapshot',
            'configure-project-agents',
            'open-project-configuration',
            'run-agent-method-workflow',
        ].includes(kind)
    )
        return 3;
    return kind === OPENCODE_CLI_INSPECT_JOB ||
        kind === OPENCODE_GLOBAL_PROVIDERS_READ_JOB ||
        kind === 'inspect-installation' ||
        PROJECT_LOCAL_READS.includes(kind) ||
        configurationRead(kind)
        ? 1
        : 2;
}

/** Выбранная при постановке роль и роль компьютера должны одновременно разрешать действие. */
export function hasDeviceJobPermission(
    claims: IAccessClaims,
    role: string,
    deviceRole: string,
    projectId: string | undefined,
    minimum: number,
): boolean {
    if (!claims.userRoles.includes(role) || !claims.userRoles.includes(deviceRole)) return false;
    return (
        !projectId ||
        Math.min(projectLevel(claims, role, projectId), projectLevel(claims, deviceRole, projectId)) >= minimum
    );
}

interface QueuePermission {
    role: string;
    project_id: string | null;
    kind: string;
}
interface QueuedJob extends QueuePermission {
    id: string;
    email: string;
}
interface DeviceIdentity {
    id: string;
    email: string;
    role: string;
}

/** Вызывается под device lock: отменяет только queued с доказанно утраченным доступом, в транзакции enqueue. */
export async function reclaimUnauthorizedQueuedJobs(
    client: PoolClient,
    device: DeviceIdentity,
    incoming: QueuePermission,
    readClaims: () => Promise<IAccessClaims>,
): Promise<boolean> {
    const { rows: queued } = await client.query<QueuedJob>(
        `SELECT id,email,role,project_id,kind FROM bridge_jobs
        WHERE device_id=$1 AND email=$2 AND state='queued' ORDER BY id FOR UPDATE`,
        [device.id, device.email],
    );
    // Сбой получения назначений прерывает запрос; он не является доказательством отзыва.
    const claims = await readClaims();
    const projectIds = [...new Set([...queued, incoming].flatMap((job) => (job.project_id ? [job.project_id] : [])))];
    const { rows: projects } = await client.query<{ id: string }>('SELECT id FROM projects WHERE id=ANY($1::text[])', [
        projectIds,
    ]);
    const existing = new Set(projects.map((project) => project.id));
    const permitted = (job: QueuePermission) =>
        hasDeviceJobPermission(claims, job.role, device.role, job.project_id ?? undefined, jobMinimumLevel(job.kind)) &&
        (job.project_id
            ? existing.has(job.project_id)
            : job.kind === 'choose-root' ||
              (job.kind === 'scan-opencode-models' &&
                  job.role === 'Главный админ' &&
                  device.role === 'Главный админ') ||
              (job.kind === OPENCODE_CLI_INSPECT_JOB && roleLevel(job.role) > 0 && roleLevel(device.role) > 0) ||
              (job.kind === OPENCODE_GLOBAL_PROVIDERS_READ_JOB &&
                  roleLevel(job.role) >= 1 &&
                  roleLevel(device.role) >= 1) ||
              (job.kind === OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB &&
                  roleLevel(job.role) >= 2 &&
                  roleLevel(device.role) >= 2) ||
              (job.kind === OPENCODE_CLI_INSTALL_JOB && roleLevel(job.role) >= 2 && roleLevel(device.role) >= 2) ||
              (job.kind === RUNTIME_CACHE_POLICY_JOB &&
                  runtimeCacheWorkRole(job.role) &&
                  runtimeCacheWorkRole(device.role)));
    if (claims.email !== device.email || !permitted(incoming))
        throw new ForbiddenException('Роль или доступ к проекту изменились. Обновите права перед новым действием.');
    const invalid = queued.filter((job) => !permitted(job)).map((job) => job.id);
    if (!invalid.length) return false;
    const { rows: cancelled } = await client.query<QueuedJob>(
        `UPDATE bridge_jobs SET state='cancelled',message=$4,result=NULL,updated_at=now()
        WHERE device_id=$1 AND email=$2 AND id=ANY($3::text[]) AND state='queued' RETURNING id,email,role,project_id,kind`,
        [device.id, device.email, invalid, REVOKED_QUEUE_MESSAGE],
    );
    for (const job of cancelled) {
        await publishMethodChatResult(client, job);
        await recordDeviceOperation(client, job, 'CANCELLED', 0, REVOKED_QUEUE_MESSAGE);
    }
    return cancelled.length > 0;
}
