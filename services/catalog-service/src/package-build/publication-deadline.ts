import type { PoolClient } from 'pg';

export const PUBLICATION_DEADLINE_MESSAGE =
    'Сервер не дождался завершения публикации. Исходники сохранены. Вернитесь к исходникам и повторите сборку новым запросом.';
interface PublicationTimeouts {
    lock_ms: string;
    statement_ms: string;
}
const capped = (value: string, maximum: number) => {
    const milliseconds = Number(value);
    return `${milliseconds === 0 ? maximum : Math.min(milliseconds, maximum)}ms`;
};

/** Caps SQL lock/statement waits in an open build transaction; lower inherited limits remain effective. */
export async function configureBuildPublicationTransaction(client: PoolClient): Promise<void> {
    const {
        rows: [current],
    } = await client.query<PublicationTimeouts>(`SELECT
        EXTRACT(EPOCH FROM current_setting('lock_timeout')::interval)*1000 AS lock_ms,
        EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval)*1000 AS statement_ms`);
    await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)", [
        capped(current.lock_ms, 5000),
        capped(current.statement_ms, 30000),
    ]);
}

/** Format the worker receipt without replacing the original SQL error or its rollback outcome. */
export function publicationDeadlineMessage(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error && ['55P03', '57014'].includes(String(error.code))
        ? PUBLICATION_DEADLINE_MESSAGE
        : undefined;
}
