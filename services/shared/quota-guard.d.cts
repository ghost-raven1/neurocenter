export type TQuotaDimension = 'current' | 'retention' | 'staging';
export type TQuotaRejectionReason = 'exceeded' | 'unavailable';
export class QuotaError extends Error {
    constructor(code: 'QUOTA_EXCEEDED' | 'QUOTA_UNAVAILABLE', dimension: TQuotaDimension);
    code: 'QUOTA_EXCEEDED' | 'QUOTA_UNAVAILABLE';
    dimension: TQuotaDimension;
    /** 507 — превышен лимит, 503 — лимиты не подтверждены (fail-closed). */
    statusCode: number;
}
export const QUOTA_DIMENSIONS: readonly TQuotaDimension[];
export interface IQuotaDecision {
    allowed: boolean;
    /** limit=0 — enforcement отключён (безлимит по AD-D4). */
    unlimited: boolean;
    used: number;
    limit: number;
    estimateBytes: number;
}
/** Чистое решение used + оценка vs limit; единственный источник решения для всех точек. */
export function decideQuota(request: { used: number; limit: number; estimateBytes: number }): IQuotaDecision;
/**
 * Фиксированное безопасное сообщение, rejection-метрика, safe-лог;
 * всегда бросает QuotaError (507 — exceeded, 503 — unavailable).
 */
export function rejectQuota(
    dimension: TQuotaDimension,
    reason: TQuotaRejectionReason,
    details?: { projectId?: string; used?: number; limit?: number; estimateBytes?: number; status?: number },
): never;
export interface ICheckQuotaRequest {
    projectId: string;
    dimension: TQuotaDimension;
    estimateBytes: number;
    catalogUrl?: string;
    internalToken?: string;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
}
/**
 * HTTP-enforcement: used и limits — из accounting каталога (GET snapshot).
 * fail-closed: любая ошибка или повреждённый снимок → QuotaError 503;
 * превышение → QuotaError 507; успех → разрешено.
 */
export function checkQuota(request: ICheckQuotaRequest): Promise<{ allowed: true; used: number; limit: number }>;
/** Строки метрики neurocenter_quota_rejections_total{dimension,reason}. */
export function renderQuotaMetrics(): string;
