import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
    DEVICE_CODEX_JOB,
    normalizeDeviceCodexResult,
    deviceCodexResultDigest,
} from '../../../shared/device-codex-inference.cjs';
import type { DeviceCompletion } from '../devices/device-completion';
import { projectDeviceCodexOperation } from './device-codex-operation';
/** Completes within the caller's locked job transaction; the public queue receives a digest only. */
export async function completeDeviceCodex(
    db: Pick<PoolClient, 'query'>,
    job: {
        id: string;
        kind: string;
        state: string;
        payload: Record<string, unknown>;
    },
    input: DeviceCompletion,
): Promise<
    | {
          ok: true;
          repeated: boolean;
      }
    | undefined
> {
    if (job.kind !== DEVICE_CODEX_JOB) return;
    let result;
    try {
        result = normalizeDeviceCodexResult(input.result);
    } catch {
        throw new BadRequestException('Некорректная приватная квитанция Codex.');
    }
    const call = (
        await db.query<{
            id: string;
            runtime_model: string;
            dispatched_at: Date | null;
            response_digest: string | null;
            result: unknown;
        }>(
            'SELECT id,runtime_model,dispatched_at,response_digest,result FROM device_model_calls WHERE job_id=$1 FOR UPDATE',
            [job.id],
        )
    ).rows[0];
    if (!call || call.id !== result.callId || result.callId !== job.payload.callId)
        throw new ConflictException('Ответ Codex относится к другому вызову.');
    const success = 'response' in result;
    if (success !== (input.state === 'succeeded') || (success && !call.dispatched_at))
        throw new ConflictException('Успех Codex требует единственной подтверждённой отправки.');
    if ('response' in result && result.response.model !== call.runtime_model)
        throw new ConflictException('Codex вернул ответ другой модели.');
    const digest = deviceCodexResultDigest(result);
    if (call.response_digest) {
        if (call.response_digest !== digest) throw new ConflictException('Вызов Codex уже содержит другой ответ.');
        return { ok: true, repeated: true };
    }
    if (!['running', 'reconciling', 'cancelled', 'failed'].includes(job.state))
        throw new ConflictException('Вызов Codex не был принят мостом.');
    await db.query(
        'UPDATE device_model_calls SET result=$2::jsonb,response_digest=$3,completed_at=clock_timestamp() WHERE job_id=$1 AND response_digest IS NULL',
        [job.id, JSON.stringify(result), digest],
    );
    const state = job.state === 'cancelled' ? 'cancelled' : input.state;
    await db.query(
        'UPDATE bridge_jobs SET state=$2,percent=$3,message=$4,result=$5::jsonb,updated_at=clock_timestamp() WHERE id=$1',
        [
            job.id,
            state,
            success ? 100 : 0,
            state === 'cancelled'
                ? 'Запрос остановлен; полученная квитанция сохранена.'
                : success
                  ? 'Ответ Codex получен.'
                  : 'Codex не завершил запрос. Автоматический повтор не выполняется.',
            JSON.stringify({ callId: call.id, responseDigest: digest, status: state }),
        ],
    );
    await projectDeviceCodexOperation(db, job.id);
    return { ok: true, repeated: false };
}
