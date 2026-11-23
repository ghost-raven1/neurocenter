/**
 * AD-O5 (res-obs 6.10): error-store — таблица error-событий сервисов
 * (crash-политика + явные report-точки). Миграция каталога 63.
 *
 * Только safe-поля (AD-O8): message — фиксированный классификатор,
 * stack_hint — кадры + имена без значений. Retention 90d (retention.json,
 * prune — maintenance tick).
 *
 * Version-neutral additive SQL; ROOT owns contiguous migration registration
 * and reset classification.
 */
export const ERROR_EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS error_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    level TEXT NOT NULL CHECK(level IN ('error','critical')),
    request_id TEXT,
    message TEXT NOT NULL,
    stack_hint TEXT
);
CREATE INDEX IF NOT EXISTS error_events_service_ts ON error_events(service, ts DESC);
CREATE INDEX IF NOT EXISTS error_events_request_id ON error_events(request_id);
`;
