import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export type TQuotaDimension = 'current' | 'retention' | 'staging';
export const QUOTA_DIMENSIONS: readonly TQuotaDimension[] = ['current', 'retention', 'staging'];
export interface IQuotaUsageInput {
    dimension: TQuotaDimension;
    deltaBytes: number;
    requestKey: string;
}
type TQueryable = Pick<PoolClient, 'query'>;

/** Тело internal API валидируется до записи: измерение, ненулевая целая дельта, непустой ключ. */
export function parseQuotaUsageInput(raw: unknown): IQuotaUsageInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException('Передайте изменение объёма объектом { dimension, deltaBytes, request_key }.');
    }
    const input = raw as Record<string, unknown>;
    const { dimension, deltaBytes, request_key: requestKey } = input;
    if (typeof dimension !== 'string' || !QUOTA_DIMENSIONS.includes(dimension as TQuotaDimension)) {
        throw new BadRequestException('Измерение квоты: current, retention или staging.');
    }
    if (typeof deltaBytes !== 'number' || !Number.isSafeInteger(deltaBytes) || deltaBytes === 0) {
        throw new BadRequestException('Изменение объёма — целое число байт, отличное от нуля.');
    }
    if (typeof requestKey !== 'string' || !requestKey || requestKey.length > 512) {
        throw new BadRequestException('Укажите ключ повторения от 1 до 512 символов.');
    }
    return { dimension: dimension as TQuotaDimension, deltaBytes, requestKey };
}

/**
 * Единая точка записи accounting: транзакция вызывающего уже открыта.
 * Квитанция (project_id, dimension, request_key) не дублируется: повторный
 * вызов с тем же ключом возвращает текущий счётчик без повторной дельты (AD-D5 pattern 4).
 */
export async function recordProjectQuotaUsage(
    db: TQueryable,
    projectId: string,
    input: IQuotaUsageInput,
): Promise<{ used: number; replayed: boolean; clamped: boolean }> {
    const found = await db.query('SELECT 1 FROM projects WHERE id=$1', [projectId]);
    if (!found.rowCount) {
        throw new NotFoundException('Проект не найден в каталоге.');
    }
    const receipt = await db.query(
        `INSERT INTO project_quota_usage_requests(project_id,dimension,request_key,delta_bytes)
         VALUES($1,$2,$3,$4) ON CONFLICT(project_id,dimension,request_key) DO NOTHING`,
        [projectId, input.dimension, input.requestKey, input.deltaBytes],
    );
    if (!receipt.rowCount) {
        const current = await db.query(
            'SELECT used_bytes FROM project_quota_usage WHERE project_id=$1 AND dimension=$2',
            [projectId, input.dimension],
        );
        return { used: Number(current.rows[0]?.used_bytes ?? 0), replayed: true, clamped: false };
    }
    const before = await db.query(
        'SELECT used_bytes FROM project_quota_usage WHERE project_id=$1 AND dimension=$2 FOR UPDATE',
        [projectId, input.dimension],
    );
    const clamped = !!before.rowCount && Number(before.rows[0].used_bytes) + input.deltaBytes < 0;
    await db.query(
        // EXCLUDED.used_bytes клампнут в 0 для INSERT-ветки; для обновления нужна
        // исходная дельта ($3), иначе отрицательные дельты теряются (floor — GREATEST).
        `INSERT INTO project_quota_usage(project_id,dimension,used_bytes) VALUES($1,$2,GREATEST(0,$3))
         ON CONFLICT(project_id,dimension) DO UPDATE SET used_bytes=GREATEST(0,project_quota_usage.used_bytes+$3),updated_at=clock_timestamp()`,
        [projectId, input.dimension, input.deltaBytes],
    );
    const after = await db.query(
        'SELECT used_bytes FROM project_quota_usage WHERE project_id=$1 AND dimension=$2',
        [projectId, input.dimension],
    );
    return { used: Number(after.rows[0].used_bytes), replayed: false, clamped };
}

/** Срез счётчиков проекта: отсутствующая строка измерения считается нулевой. */
export async function readProjectQuotaUsage(
    db: TQueryable,
    projectId: string,
): Promise<Record<TQuotaDimension, number>> {
    const rows = (await db.query('SELECT dimension,used_bytes FROM project_quota_usage WHERE project_id=$1', [
        projectId,
    ])).rows as Array<{ dimension: TQuotaDimension; used_bytes: number | string }>;
    const used: Record<string, number> = {};
    for (const row of rows) used[row.dimension] = Number(row.used_bytes);
    return { current: used.current ?? 0, retention: used.retention ?? 0, staging: used.staging ?? 0 };
}
