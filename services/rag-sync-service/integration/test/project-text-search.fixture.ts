import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { RagDb } from '../../src/rag/rag-db';
import { ProjectTextStore } from '../../src/project-text/text-store';

/** Disposable database only: never migrate the supplied admin database or a running stand. */
export async function textSearchFixture(connection: string) {
    const url = new URL(connection);
    if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.hostname !== '127.0.0.1' ||
        !url.username.startsWith('qa_') ||
        !url.port ||
        url.port === '5432' ||
        url.pathname !== '/postgres' ||
        url.search ||
        url.hash
    )
        throw new Error('An owned loopback QA PostgreSQL connection is required.');
    const name = 'nc_text_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: url.href, max: 1 });
    let created = false;
    let db: RagDb | undefined;
    let pool: Pool | undefined;
    const dispose = async () => {
        try {
            await db?.close();
            await pool?.end();
            if (created) await admin.query('DROP DATABASE ' + name);
            if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount)
                throw new Error('Owned text database remains.');
        } finally {
            await admin.end();
        }
    };
    try {
        await admin.query('CREATE DATABASE ' + name + " TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
        created = true;
        url.pathname = '/' + name;
        db = new RagDb({ url: url.href });
        await db.setup();
        pool = new Pool({ connectionString: url.href, max: 4 });
        return { pool, text: new ProjectTextStore(pool), project: 'prj-' + randomUUID(), dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
}
