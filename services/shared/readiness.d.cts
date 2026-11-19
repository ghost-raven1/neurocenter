export interface IReadiness {
    ok: boolean;
    checks: Record<string, 'ready' | 'unavailable'>;
}
/** Таймаут агрегированной проверки зависимостей (readiness), мс. */
export const READINESS_CHECK_TIMEOUT_MS: number;
/** Таймаут одиночного HTTP /ready запроса к зависимому сервису, мс. */
export const HTTP_READY_TIMEOUT_MS: number;
/** Максимальный размер тела JSON-квитанции /ready, байты. */
export const READY_BODY_LIMIT_BYTES: number;
/** Ограниченная по времени проверка зависимостей без раскрытия секретов. */
export function checkReadiness(checks: Record<string, () => Promise<unknown>>): Promise<IReadiness>;
export function httpReady(base: string): Promise<void>;
