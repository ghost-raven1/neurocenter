import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

/** Одноразовая подготовка кластера: superuser-секрет не передаётся рабочим сервисам. */
async function main(): Promise<void> {
    const directory = process.env.PRODUCTION_SECRETS_DIR || '/run/secrets';
    const read = (file: string): string => {
        const value = readFileSync(directory + '/' + file, 'utf8').trim();
        if (!value || /[\x00\r\n]/.test(value)) {
            throw new Error('Некорректный файл настройки БД');
        }
        return value;
    };
    const ownerPassword = read('postgres_password');
    if (!/^[a-f0-9]{64}$/.test(ownerPassword)) {
        throw new Error('Нужен сгенерированный пароль владельца БД');
    }
    const definitions = [
        ['catalog_url', 'nc_catalog', 'catalog', false],
        ['rag_url', 'nc_rag', 'rag', false],
        ['rag_provision_url', 'nc_provisioner', 'postgres', true],
        ['backup_url', 'nc_backup', 'rag', false],
    ] as const;
    const credentials = definitions.map(([file, role, database, createDb]) => {
        const url = new URL(read(file));
        if (
            url.username !== role ||
            url.hostname !== 'postgres' ||
            url.port !== '5432' ||
            url.pathname !== '/' + database ||
            !/^[a-f0-9]{64}$/.test(url.password)
        ) {
            throw new Error('Подключение БД не соответствует production-профилю');
        }
        return { role, database, createDb, password: url.password };
    });
    const pool = new Pool({
        host: process.env.PRODUCTION_PG_HOST || 'postgres',
        user: 'nc_owner',
        password: ownerPassword,
        database: 'postgres',
        max: 1,
        connectionTimeoutMillis: 10000,
    });
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock(72465382)');
        for (const item of credentials) {
            const found = await client.query(
                'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',
                [item.role],
            );
            if (found.rowCount) {
                const role = found.rows[0];
                if (
                    role.rolsuper ||
                    role.rolcreaterole ||
                    role.rolreplication ||
                    role.rolbypassrls ||
                    role.rolcreatedb !== item.createDb
                ) {
                    throw new Error('Права роли ' + item.role + ' требуют ручной проверки');
                }
            } else {
                await client.query(
                    `CREATE ROLE ${item.role} LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS ${item.createDb ? 'CREATEDB' : 'NOCREATEDB'} PASSWORD '${item.password}'`,
                );
            }
        }
        await client.query('GRANT nc_rag TO nc_provisioner');
        await client.query('GRANT pg_read_all_data TO nc_backup');
        for (const [database, owner] of [
            ['catalog', 'nc_catalog'],
            ['rag', 'nc_rag'],
            ['nc_rag_template', 'nc_rag'],
        ]) {
            const exists = await client.query(
                'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
                [database],
            );
            if (exists.rowCount && exists.rows[0].owner !== owner) {
                throw new Error('Владелец базы ' + database + ' требует ручной проверки');
            }
            if (!exists.rowCount) {
                await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
            }
            await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
        }
        await client.query('GRANT CONNECT ON DATABASE rag TO nc_backup');
        const template = new Pool({
            host: process.env.PRODUCTION_PG_HOST || 'postgres',
            user: 'nc_owner',
            password: ownerPassword,
            database: 'nc_rag_template',
            max: 1,
        });
        try {
            await client.query('ALTER DATABASE nc_rag_template ALLOW_CONNECTIONS true');
            await template.query('CREATE EXTENSION IF NOT EXISTS vector');
        } finally {
            await template.end();
            await client.query('ALTER DATABASE nc_rag_template IS_TEMPLATE true ALLOW_CONNECTIONS false');
        }
        const legacy = new Pool({
            host: process.env.PRODUCTION_PG_HOST || 'postgres',
            user: 'nc_owner',
            password: ownerPassword,
            database: 'rag',
            max: 1,
        });
        try {
            await legacy.query('CREATE EXTENSION IF NOT EXISTS vector');
        } finally {
            await legacy.end();
        }
        console.log(JSON.stringify({ ok: true, roles: credentials.length, template: true }));
    } finally {
        await client.query('SELECT pg_advisory_unlock(72465382)');
        client.release();
        await pool.end();
    }
}
void main().catch((error) => {
    console.error(
        error instanceof Error && error.message.includes('требуют ручной')
            ? error.message
            : 'Не удалось подготовить production-БД. Проверьте закрытые файлы и доступ к PostgreSQL.',
    );
    process.exitCode = 1;
});
