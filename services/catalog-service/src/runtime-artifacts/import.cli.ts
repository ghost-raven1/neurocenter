import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { RuntimeArtifacts } from './runtime-artifacts';
import type { DeviceStore } from '../devices/device-store';

/** Оператор передаёт готовый USTAR .tar.gz и его одобренное описание; код архива не исполняется. */
async function main(): Promise<void> {
    process.umask(0o077);
    const [, , archive, descriptorFile, ...rest] = process.argv;
    if (!archive || !descriptorFile || rest.length) {
        throw new Error('Использование: node dist/runtime-artifacts/import.cli.js <готовый.tar.gz> <descriptor.json>');
    }
    const input = await fs.readFile(descriptorFile);
    if (input.length > 4096) {
        throw new Error('Описание артефакта превышает 4 КиБ.');
    }
    const connectionString =
        process.env.CATALOG_PG_URL ||
        (process.env.CATALOG_PG_URL_FILE
            ? (await fs.readFile(process.env.CATALOG_PG_URL_FILE, 'utf8')).trim()
            : undefined);
    if (!connectionString) {
        throw new Error('Укажите CATALOG_PG_URL или CATALOG_PG_URL_FILE.');
    }
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });
    try {
        const result = await new RuntimeArtifacts({ pool } as unknown as DeviceStore).importArchive(
            archive,
            JSON.parse(input.toString('utf8')),
        );
        console.log(JSON.stringify({ ok: true, artifact: result }));
    } finally {
        await pool.end();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Импорт артефакта не выполнен.');
    process.exitCode = 1;
});
