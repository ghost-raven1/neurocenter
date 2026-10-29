import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';

/** Creates and drops only the explicitly caller-owned, uniquely named context test database. */
export async function textContextDatabase(connection: string | undefined) {
    const url = ownedTestPostgresAdmin(connection), admin = new Pool({ connectionString: url.href, max: 1 });
    const name = 'nc_text_context_' + randomUUID().replaceAll('-', ''); let pool: Pool | undefined;
    try {
        await admin.query('CREATE DATABASE ' + name); url.pathname = '/' + name;
        pool = new Pool({ connectionString: url.href, max: 6, options: '-c statement_timeout=10000' });
        return { pool, name, async close() { await pool!.end(); try { await admin.query('DROP DATABASE IF EXISTS ' + name); } finally { await admin.end(); } } };
    } catch (error) { await pool?.end(); try { await admin.query('DROP DATABASE IF EXISTS ' + name); } finally { await admin.end(); } throw error; }
}
