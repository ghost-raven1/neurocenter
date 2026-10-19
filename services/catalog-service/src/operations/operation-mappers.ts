import type { IOperation, IOperationDetail } from '../catalog/dto';
import { deviceJobRetryPolicy } from '../devices/device-job-retry';
import type { IOperationRow } from './operation.types';

export function toOperation(row: IOperationRow): IOperation {
    const retryPolicy = row.bridge_job_kind ? deviceJobRetryPolicy(row.bridge_job_kind) : undefined;
    // Удаление проекта сохраняет историю, но исключает невыполнимый повтор из неё.
    const retryTargetExists = row.bridge_job_project_exists === true
        || (row.project_id === null && row.bridge_job_kind === 'choose-root');
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
        ...(retryPolicy ? { bridgeJob: { ...retryPolicy, retrySupported: retryPolicy.retrySupported && retryTargetExists } } : {}),
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
