/**
 * Quota AD-D4: учёт занятого RAG-накопления проекта (измерение retention).
 *
 * После фиксации RAG-изменений (applyDelta / генерация / отмена генерации)
 * rag-sync отправляет точную дельту в bytes в catalog
 * `POST /internal/projects/:projectId/quota-usage` с размерностью `retention`.
 * Дельта считается через `neurocenter_rag_row_bytes(c)` — ту же функцию, что
 * использует триггер `rag_storage_budget` (единый метод измерения).
 *
 * Best-effort: ошибка доставки не откатывает запись RAG-данных (причина —
 * повторная синхронизация/генерация с тем же `requestKey` перезапишет receipt
 * идемпотентно; систематический разрыв перекрывается reconciliation story 8
 * эпика 5). Ошибки логируются как warn.
 */
export interface IRagQuotaUsageRecord {
    /** project_id из карточки проекта (catalog UUID). */
    projectId: string;
    /** Изменение занятого пространства в bytes (сумма по всем строкам). */
    deltaBytes: number;
    /** Идемпотентный ключ: `intent:<intentId>` | `gen-create:<id>` | `gen-cancel:<id>`. */
    requestKey: string;
}

export type TQuotaFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface IRagQuotaUsageDelivery {
    catalogUrl?: string;
    internalToken?: string;
    fetchImpl?: TQuotaFetch;
    logger?: (message: string) => void;
}

/**
 * Отправляет записи учёта quota в catalog. Каждая запись — отдельный запрос;
 * провал одной не мешает остальным, провал не пробрасывается наружу.
 *
 * @param records — записи учёта (пустой массив — no-op).
 * @param options — параметры доставки (env-переменные по умолчанию).
 * @returns количество успешно доставленных записей.
 */
export async function deliverRagQuotaUsage(
    records: readonly IRagQuotaUsageRecord[],
    options: IRagQuotaUsageDelivery = {},
): Promise<number> {
    if (records.length === 0) return 0;
    const base = (options.catalogUrl ?? process.env.CATALOG_SERVICE_URL ?? 'http://localhost:4100').replace(/\/+$/, '');
    const token = options.internalToken ?? process.env.NEUROCENTER_INTERNAL_TOKEN ?? '';
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const warn = options.logger ?? ((message: string) => console.warn(message));
    let delivered = 0;
    for (const record of records) {
        try {
            const response = await fetchImpl(`${base}/internal/projects/${encodeURIComponent(record.projectId)}/quota-usage`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token },
                body: JSON.stringify({ dimension: 'retention', deltaBytes: record.deltaBytes, requestKey: record.requestKey }),
            });
            if (!response.ok) {
                warn(
                    `[rag-sync-service] quota usage delivery failed project=${record.projectId} requestKey=${record.requestKey} status=${response.status}`,
                );
                continue;
            }
            delivered += 1;
        } catch (error) {
            warn(
                `[rag-sync-service] quota usage delivery failed project=${record.projectId} requestKey=${record.requestKey} error=${String(error)}`,
            );
        }
    }
    return delivered;
}
