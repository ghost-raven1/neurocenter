import { ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import {
    MEMORY_SYNC_JOB,
    normalizeMemorySyncPayload,
    normalizeMemorySyncResult,
} from '../../../shared/project-learning-memory-sync.cjs';
import type { DeviceCompletion } from '../devices/device-completion';
import { recordDeviceOperation } from '../devices/device-operations';

/** Late delivery preserves cancellation and accepts partial recovery even after the feature is disabled. */
export async function completeLearningMemory(
    db: PoolClient,
    job: {
        id: string;
        kind: string;
        email: string;
        project_id: string | null;
        state: string;
        payload: Record<string, unknown>;
        result?: unknown;
    },
    input: DeviceCompletion,
) {
    if (job.kind !== MEMORY_SYNC_JOB) return;
    let result;
    try {
        result = normalizeMemorySyncResult(input.result, normalizeMemorySyncPayload(job.payload.memory));
    } catch {
        throw new ConflictException('Некорректная квитанция синхронизации Memory.');
    }
    if ((result.status === 'complete') !== (input.state === 'succeeded'))
        throw new ConflictException('Статус Memory не соответствует квитанции.');
    if (job.result) {
        if (!isDeepStrictEqual(job.result, result))
            throw new ConflictException('Квитанция Memory уже зафиксирована иначе.');
        return { ok: true, repeated: true };
    }
    if (!['running', 'reconciling', 'cancelled', 'failed'].includes(job.state))
        throw new ConflictException('Мост не принимал это задание Memory.');
    const state = job.state === 'cancelled' ? 'cancelled' : input.state;
    const message =
        state === 'cancelled'
            ? 'Синхронизация остановлена; квитанция сохранена.'
            : result.status === 'complete'
              ? 'Принятые знания синхронизированы с Memory.'
              : 'Синхронизация выполнена частично. Сохранённый план доступен для продолжения.';
    await db.query(
        'UPDATE bridge_jobs SET state=$2,percent=$3,message=$4,result=$5::jsonb,updated_at=now() WHERE id=$1',
        [job.id, state, result.status === 'complete' ? 100 : 0, message, JSON.stringify(result)],
    );
    await recordDeviceOperation(db, job, state.toUpperCase(), result.status === 'complete' ? 100 : 0, message);
    return { ok: true, repeated: false };
}
