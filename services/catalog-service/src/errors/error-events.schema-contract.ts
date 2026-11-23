/**
 * AD-O5 (res-obs 6.10): зафиксированные физические факты схемы error_events
 * (DDL — error-events.schema.ts, миграция 63). Факты сняты с полного
 * прогона миграций в пустой БД; invariant-проверка — assertErrorEventsSchema.
 */
export const ERROR_EVENTS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'error_events.id',
        definition: { type: 'uuid', default: 'gen_random_uuid()', notNull: true },
    },
    { kind: 'column', id: 'error_events.level', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'error_events.message', definition: { type: 'text', default: null, notNull: true } },
    { kind: 'column', id: 'error_events.request_id', definition: { type: 'text', default: null, notNull: false } },
    { kind: 'column', id: 'error_events.service', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'error_events.stack_hint',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'error_events.ts',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'error_events.error_events_level_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (level = ANY (ARRAY['error'::text, 'critical'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'error_events.error_events_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'index',
        id: 'error_events_pkey',
        definition: {
            valid: true,
            ready: true,
            definition: 'CREATE UNIQUE INDEX error_events_pkey ON error_events USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'error_events_request_id',
        definition: {
            valid: true,
            ready: true,
            definition: 'CREATE INDEX error_events_request_id ON error_events USING btree (request_id)',
        },
    },
    {
        kind: 'index',
        id: 'error_events_service_ts',
        definition: {
            valid: true,
            ready: true,
            definition: 'CREATE INDEX error_events_service_ts ON error_events USING btree (service, ts DESC)',
        },
    },
    { kind: 'table', id: 'error_events', definition: { kind: 'r', persistence: 'p' } },
];
