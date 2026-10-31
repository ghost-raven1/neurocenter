import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { BROWSER_AUTH_SESSION_GUARD_BODY } from './browser-auth-session.schema';

/** Source-derived expectations require the separate owned PostgreSQL acceptance, not a fixture claim. */
export const BROWSER_AUTH_SESSION_SCHEMA_CONTRACT = [
    { kind: 'table', id: 'browser_auth_sessions', definition: { kind: 'r', persistence: 'p' } },
    ...['token_hash', 'identity', 'selected_role', 'created_at', 'expires_at', 'revoked_at'].map((name) => ({
        kind: 'column',
        id: 'browser_auth_sessions.' + name,
        definition: {
            type: name === 'identity' ? 'jsonb' : name.endsWith('_at') ? 'timestamp with time zone' : 'text',
            default: name === 'created_at' ? 'now()' : null,
            notNull: name !== 'revoked_at',
        },
    })),
    {
        kind: 'constraint',
        id: 'browser_auth_sessions.browser_auth_sessions_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (token_hash)' },
    },
    {
        kind: 'index',
        id: 'browser_auth_sessions_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX browser_auth_sessions_pkey ON browser_auth_sessions USING btree (token_hash)',
        },
    },
    {
        kind: 'index',
        id: 'browser_auth_sessions_expiry',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE INDEX browser_auth_sessions_expiry ON browser_auth_sessions USING btree (expires_at)',
        },
    },
];
/** Checks physical shape and the exact enabled INSERT/UPDATE validation/immutability guard. */
export async function assertBrowserAuthSessionSchema(db: Pick<Pool, 'query'>): Promise<void> {
    const { rows } = await db.query<{ issue: string }>(
        `WITH expected AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
 SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition
 UNION ALL SELECT 'browser_auth_session_guard' WHERE NOT EXISTS(
  SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
  WHERE t.tgrelid=to_regclass('public.browser_auth_sessions') AND t.tgname='browser_auth_session_guard'
   AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=23 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text=''
   AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
   AND p.pronamespace='public'::regnamespace AND p.proname='browser_auth_session_guard' AND p.pronargs=0 AND p.prorettype='trigger'::regtype
   AND NOT p.prosecdef AND p.provolatile='v' AND p.proconfig IS NULL
   AND l.lanname='plpgsql' AND p.prosrc=$2)`,
        [JSON.stringify(BROWSER_AUTH_SESSION_SCHEMA_CONTRACT), BROWSER_AUTH_SESSION_GUARD_BODY],
    );
    if (rows.length)
        throw new Error(
            'Схема браузерных сессий не готова: ' +
                rows
                    .slice(0, 10)
                    .map((row) => row.issue)
                    .join(', '),
        );
}
