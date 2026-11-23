import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { IPage } from '../catalog/dto';

/**
 * AD-O5 (res-obs 6.10): error-store — события ошибок сервисов в каталоге.
 * Писатели без прямого PG доставляют пакеты из file outbox (POST /internal/error-events);
 * идемпотентность — стабильный id (ON CONFLICT DO NOTHING). Только safe-поля (AD-O8):
 * message — фиксированный классификатор, stack_hint — кадры + имена без значений.
 */

export type TErrorEventLevel = 'error' | 'critical';

export interface IErrorEvent {
    /** Стабильный id (UUID): повторная доставка из outbox не дублирует запись. */
    id?: string;
    /** Имя сервиса-писателя (catalog-service, api-gateway, ...). */
    service: string;
    /** crash = 'critical' (уровень журнала — 'error'); явные report-точки — 'error'. */
    level: TErrorEventLevel;
    /** Фиксированный классификатор (AD-O8), не произвольный текст. */
    message: string;
    requestId?: string | null;
    /** Кадры + имена, ≤ 4 КБ (AD-O5 OQ-1); значения переменных не передаются. */
    stackHint?: string | null;
}

export interface IErrorEventRow {
    id: string;
    service: string;
    ts: string;
    level: TErrorEventLevel;
    requestId: string | null;
    message: string;
    stackHint: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Мгновенная запись события; ts — серверное now() (момент приёма). */
export async function insertErrorEvent(client: Pick<PoolClient, 'query'>, event: IErrorEvent): Promise<void> {
    const id = event.id && UUID_RE.test(event.id) ? event.id.toLowerCase() : randomUUID();
    await client.query(
        'INSERT INTO error_events(id,service,ts,level,request_id,message,stack_hint) VALUES($1,$2,now(),$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
        [id, event.service, event.level, event.requestId ?? null, event.message, event.stackHint ?? null],
    );
}

export interface IErrorEventQuery {
    service?: string;
    requestId?: string;
    level?: TErrorEventLevel;
    /** Период: только события с ts не раньше. */
    since?: Date;
    page: number;
    size: number;
}

/** Страница error-событий (порядок и пагинация — как в listAuditHistory). */
export async function listErrorEvents(pool: Pick<Pool, 'query'>, query: IErrorEventQuery): Promise<IPage<IErrorEventRow>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace('$?', '$' + params.length));
    };
    if (query.service) push('service = $?', query.service);
    if (query.requestId) push('request_id = $?', query.requestId);
    if (query.level) push('level = $?', query.level);
    if (query.since) push('ts >= $?', query.since);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [count, rows] = await Promise.all([
        pool.query<{ n: number }>('SELECT count(*)::int AS n FROM error_events ' + whereSql, params),
        pool.query<IErrorEventRow>(
            'SELECT id,service,ts,level,request_id AS "requestId",message,stack_hint AS "stackHint" FROM error_events ' +
                whereSql +
                ' ORDER BY ts DESC, id DESC LIMIT $' +
                (params.length + 1) +
                ' OFFSET $' +
                (params.length + 2),
            [...params, query.size, (query.page - 1) * query.size],
        ),
    ]);
    return { items: rows.rows, page: query.page, size: query.size, total: count.rows[0].n };
}
