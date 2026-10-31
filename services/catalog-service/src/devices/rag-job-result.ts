import { ConflictException } from '@nestjs/common';
import { RAG_JOB_KINDS } from './rag-job-binding';

export const RAG_UPGRADE_RESULT = { code: 'rag-contract-upgrade-required', needsResync: true };
export const RAG_UPGRADE_MESSAGE =
    'Задание создано прежней версией моста. Индекс не подтверждён. Обновите мост и повторите действие для выбранной папки.';
export const isLegacyRagJob = (job: { kind: string; payload: { bindingId?: unknown } }): boolean =>
    RAG_JOB_KINDS.includes(job.kind) && job.payload?.bindingId == null;

/** Только завершённая проверенная копия исходной папки подтверждает успешное RAG-задание. */
export function assertRagJobResult(
    job: { kind: string; project_id: string | null; payload: { bindingId?: unknown } },
    result: Record<string, unknown>,
    failed: boolean,
): void {
    if (!RAG_JOB_KINDS.includes(job.kind)) {
        return;
    }
    if (failed) {
        const upgrade =
            isLegacyRagJob(job) &&
            Object.keys(result).length === 2 &&
            result.code === RAG_UPGRADE_RESULT.code &&
            result.needsResync === true;
        if (Object.keys(result).length && !upgrade) {
            throw new ConflictException('Ошибка синхронизации не должна передавать локальные данные.');
        }
        return;
    }
    const profile = result.indexProfile as Record<string, unknown> | undefined;
    const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0;
    const counters = [
        'localCount',
        'upserted',
        'deleted',
        'appliedNow',
        'added',
        'removed',
        'dimension',
        'written',
        'sourceCount',
        'batches',
    ];
    const allowed = [
        'projectId',
        'bindingId',
        'ok',
        'applied',
        'complete',
        'remaining',
        'fingerprintVersion',
        'indexProfile',
        'snapshotHash',
        'created',
        ...counters,
    ];
    if (
        typeof job.payload.bindingId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(job.payload.bindingId) ||
        Object.keys(result).some((key) => !allowed.includes(key)) ||
        counters.some(
            (key) => result[key] !== undefined && (!Number.isSafeInteger(result[key]) || Number(result[key]) < 0),
        ) ||
        (result.created !== undefined && typeof result.created !== 'boolean') ||
        result.projectId !== job.project_id ||
        result.bindingId !== job.payload.bindingId ||
        result.ok !== true ||
        result.applied !== true ||
        result.complete !== true ||
        result.remaining !== 0 ||
        result.fingerprintVersion !== 1 ||
        typeof result.snapshotHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.snapshotHash) ||
        !profile ||
        Object.keys(profile).length !== 3 ||
        !['provider', 'model', 'dimension'].every((key) => key in profile) ||
        typeof profile.provider !== 'string' ||
        !profile.provider ||
        profile.provider.length > 512 ||
        typeof profile.model !== 'string' ||
        !profile.model ||
        profile.model.length > 512 ||
        !positive(profile.dimension) ||
        (result.dimension !== undefined && result.dimension !== profile.dimension) ||
        (job.kind === 'sync-rag' ? !positive(result.localCount) : !positive(result.written))
    ) {
        throw new ConflictException(
            'Для завершения синхронизации нужен полный проверенный индекс исходной привязки папки.',
        );
    }
}
