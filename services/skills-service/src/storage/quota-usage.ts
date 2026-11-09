/**
 * Quota AD-D4: учёт занятого пространства project-скиллами (измерение current).
 *
 * После фиксации изменений скиллов (applyChangesLocked — единый funnel
 * create/update/delete) skills-service отправляет точную дельту в bytes в
 * catalog `POST /internal/projects/:projectId/quota-usage` с размерностью
 * `current`. Дельта = byteLength(after) − byteLength(before) по сериализованным
 * файлам (те же байты, что пишутся на диск).
 *
 * Атрибуция (OQ-4): project-скиллы лежат в каталоге `project-<projectKey>`;
 * приоритет у `meta.projectId`, иначе — path-prefix. `common/`-скиллы (без
 * projectId) не учитываются.
 *
 * Идемпотентность: requestKey детерминирован содержимым изменения, поэтому
 * повтор той же операции не создаёт дубля. Ограниченный дрейф (последовательные
 * write→delete→identical rewrite) перекрывается reconciliation story 8 эпика 5.
 *
 * Best-effort: ошибка доставки не откатывает запись (повторная синхронизация с
 * тем же requestKey идемпотентна); ошибки логируются как warn.
 */
import { createHash } from 'node:crypto';
import type { ISkillFileChange } from './skill-journal';

export interface ISkillQuotaUsageRecord {
    /** project_id, к которому относится изменение (каталог UUID). */
    projectId: string;
    /** Изменение занятого пространства в bytes. */
    deltaBytes: number;
    /** Детерминированный идемпотентный ключ: `skill:<relative>:<sha256(изменение)>`. */
    requestKey: string;
}

export type TDeliverSkillQuotaUsage = (records: ISkillQuotaUsageRecord[]) => Promise<void>;

/** Атрибуция по пути: каталог `project-<key>` — проект; остальное (common/) — не учитывается. */
export function projectIdFromSkillPath(skillPath: string): string | null {
    const top = skillPath.split('/')[0];
    if (!top.startsWith('project-')) {
        return null;
    }
    const key = top.slice('project-'.length);
    return key.length > 0 ? key : null;
}

/** Детерминированный ключ идемпотентности для изменения файла. */
export function skillQuotaRequestKey(entry: ISkillFileChange): string {
    const digest = createHash('sha256')
        .update(JSON.stringify({ relative: entry.relative, before: entry.before, after: entry.after }))
        .digest('hex');
    return `skill:${entry.relative}:${digest}`;
}

export interface ISkillQuotaUsageChange {
    entry: ISkillFileChange;
    /** `meta.projectId` изменения (для записей); для удаления — атрибутация по пути. */
    metaProjectId?: string | null;
}

const byteLength = (raw: string | null): number => (raw === null ? 0 : Buffer.byteLength(raw));

/**
 * Сводит изменения файлов в записи учёта quota: дельта по байтам, атрибуция по
 * проекту, детерминированный ключ. Изменения без проекта (common/) и нулевые
 * дельты пропускаются.
 */
export function skillQuotaUsageRecords(changes: readonly ISkillQuotaUsageChange[]): ISkillQuotaUsageRecord[] {
    const records: ISkillQuotaUsageRecord[] = [];
    for (const { entry, metaProjectId } of changes) {
        const projectId =
            metaProjectId && metaProjectId.length > 0
                ? metaProjectId
                : projectIdFromSkillPath(entry.relative.slice(0, -3));
        if (!projectId) {
            continue;
        }
        const deltaBytes = byteLength(entry.after) - byteLength(entry.before);
        if (deltaBytes === 0) {
            continue;
        }
        records.push({ projectId, deltaBytes, requestKey: skillQuotaRequestKey(entry) });
    }
    return records;
}

export interface ISkillQuotaUsageDelivery {
    catalogUrl?: string;
    internalToken?: string;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    warn?: (message: string) => void;
}

/**
 * Отправляет записи учёта quota в catalog. Каждая запись — отдельный запрос;
 * провал одной не мешает остальным и не пробрасывается наружу (best-effort).
 *
 * @returns количество успешно доставленных записей.
 */
export async function deliverSkillQuotaUsage(
    records: readonly ISkillQuotaUsageRecord[],
    options: ISkillQuotaUsageDelivery = {},
): Promise<number> {
    if (records.length === 0) {
        return 0;
    }
    const base = (options.catalogUrl ?? process.env.CATALOG_SERVICE_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
    const token = options.internalToken ?? process.env.NEUROCENTER_INTERNAL_TOKEN ?? '';
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const warn = options.warn ?? ((message: string) => console.warn(message));
    let delivered = 0;
    for (const record of records) {
        try {
            const response = await fetchImpl(
                `${base}/internal/projects/${encodeURIComponent(record.projectId)}/quota-usage`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token },
                    body: JSON.stringify({ dimension: 'current', deltaBytes: record.deltaBytes, requestKey: record.requestKey }),
                },
            );
            if (!response.ok) {
                warn(
                    `[skills-service] quota usage delivery failed project=${record.projectId} requestKey=${record.requestKey} status=${response.status}`,
                );
                continue;
            }
            delivered += 1;
        } catch (error) {
            warn(
                `[skills-service] quota usage delivery failed project=${record.projectId} requestKey=${record.requestKey} error=${String(error)}`,
            );
        }
    }
    return delivered;
}

/** Конструктор для инъекции в хранилище: best-effort доставка без проброса ошибок. */
export const deliverSkillQuota: TDeliverSkillQuotaUsage = async (records) => {
    await deliverSkillQuotaUsage(records);
};
