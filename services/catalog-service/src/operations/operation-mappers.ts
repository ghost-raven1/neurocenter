import type { IOperation, IOperationDetail } from '../catalog/dto';
import { deviceJobRetryPolicy } from '../devices/device-job-retry';
import type { IOperationRow } from './operation.types';

export function toOperation(row: IOperationRow): IOperation {
    return {
        operationId: row.operation_id,
        type: row.type as IOperation['type'],
        projectId: row.project_id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        actor: row.actor,
        state: row.state as IOperation['state'],
        percent: row.percent,
        bytesDone: Number(row.bytes_done),
        bytesTotal: Number(row.bytes_total),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        error: row.error,
        ...(row.bridge_job_kind ? { bridgeJob: deviceJobRetryPolicy(row.bridge_job_kind) } : {}),
    };
}

/** Поддерживает JSONB и строковый журнал старых записей. */
export function toOperationDetail(row: IOperationRow): IOperationDetail {
    return {
        ...toOperation(row),
        log: typeof row.log === 'string' ? (JSON.parse(row.log) as IOperationDetail['log']) : (row.log ?? []),
        retries: row.retries,
    };
}
