import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { Pool } from 'pg';
import { PLATFORM_QUOTA_CACHE_SCHEMA, PLATFORM_QUOTA_SCHEMA } from '../src/rag/quota/platform-quota-schema';

/** Reject libpq URL overrides and application defaults before opening a fixture connection. */
export function ownedQuotaRollbackUrl(value: string): URL {
    let url: URL; try { url = new URL(value); } catch { throw Error('An explicit owned PostgreSQL admin URL is required.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.port || url.port === '5432'
        || url.pathname !== '/postgres' || url.search || url.hash) throw Error('Use a loopback PostgreSQL admin URL on a non-default port without URL overrides.');
    return url;
}

/** Only quota tables and their real public schema are needed; no extensions or application database. */
export async function quotaRollbackFixture(value: string) {
    const url = ownedQuotaRollbackUrl(value), disk = await statfs(process.cwd(), { bigint: true });
    if (disk.bavail * disk.bsize < 4n * 1024n ** 3n) throw Error('Quota rollback fixture requires 4 GiB free disk.');
    const database = 'ragrollbacklane_' + randomUUID().replaceAll('-', ''), admin = new Pool({ connectionString: url.href, max: 1 });
    let pool: Pool | undefined, observer: Pool | undefined, created = false;
    const dispose = async () => {
        try {
            await observer?.end(); await pool?.end();
            if (created) await admin.query('DROP DATABASE ' + database);
            const databases = (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [database])).rows;
            const sessions = (await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [database])).rows;
            if (databases.length || sessions.length) throw Error('Owned quota fixture resources remain.');
            return { database, dropped: created && databases.length === 0, databasesRemaining: databases, sessionsRemaining: sessions };
        } finally { await admin.end(); }
    };
    try {
        await admin.query('CREATE DATABASE ' + database); created = true; url.pathname = '/' + database;
        pool = new Pool({ connectionString: url.href, max: 1 }); observer = new Pool({ connectionString: url.href, max: 1 });
        await pool.query(PLATFORM_QUOTA_SCHEMA + PLATFORM_QUOTA_CACHE_SCHEMA + `
            CREATE TABLE rag_storage_settings(singleton boolean PRIMARY KEY,default_bytes bigint NOT NULL,maximum_bytes bigint NOT NULL);
            INSERT INTO rag_platform_quota_policy(singleton,default_bytes,maximum_bytes,updated_by) VALUES(true,100,200,'fixture');
            INSERT INTO rag_platform_quota_applied(singleton,revision,default_bytes,maximum_bytes) VALUES(true,0,100,200);
            INSERT INTO rag_storage_settings(singleton,default_bytes,maximum_bytes) VALUES(true,100,200);`);
        return { pool, observer, database, dispose };
    } catch (error) { await dispose(); throw error; }
}

/** Only ACK delivery is faulted: every targeted business statement and optional COMMIT executes on PostgreSQL. */
export function quotaFaultPool(pool: Pool, kind: 'policy' | 'applied', boundary: 'update' | 'commit' | 'none', rollbackFails: boolean) {
    const failure = new Error('Own quota ' + boundary + ' acknowledgement lost'), rollbackFailure = new Error('Own rollback acknowledgement lost');
    let pid = 0, release: Error | boolean | undefined, fired = false;
    const sql: string[] = [];
    const wrapped = { connect: async () => {
        const client = await pool.connect(), query = client.query.bind(client);
        pid = Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return { query: async (text: string, ...args: unknown[]) => {
            sql.push(text);
            if (text === 'ROLLBACK' && rollbackFails) throw rollbackFailure;
            const result = await (query as (...values: unknown[]) => Promise<unknown>)(text, ...args);
            const mutation = kind === 'policy' ? text.startsWith('UPDATE rag_platform_quota_policy SET') : text.startsWith('UPDATE rag_storage_settings SET');
            if (!fired && (boundary === 'update' && mutation || boundary === 'commit' && text === 'COMMIT')) { fired = true; throw failure; }
            return result;
        }, release: (discard?: Error | boolean) => { release = discard; client.release(discard); } };
    } } as unknown as Pool;
    return { pool: wrapped, failure, rollbackFailure, sql, pid: () => pid, release: () => release, fired: () => fired };
}
