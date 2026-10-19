import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { CatalogDb } from '../catalog/catalog-db';
import { DeviceStore } from '../devices/device-store';
import type { AccessDb } from '../access/access-db';
import { syncBuiltinCatalog } from './sync';
import { validateBuiltinManifest } from './manifest';
import { BuiltinCatalogFailure, builtinCatalogError, builtinCatalogWarnings } from './diagnostics';

/** Операторская доставка не требует браузерной сессии и не выводит строки подключения. */
async function main(): Promise<void> {
    process.umask(0o077);
    const [, , filename, ...flags] = process.argv;
    if (!filename || flags.length > 1 || flags.some(flag => !['--dry-run', '--download-only', '--skip-conflicts'].includes(flag))) {
        throw new BuiltinCatalogFailure('Использование: node dist/builtin-catalog/sync.cli.js <manifest.json> [--dry-run | --download-only | --skip-conflicts]');
    }
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) { throw new BuiltinCatalogFailure('Нужен обычный manifest.json до 16 МиБ.'); }
    const contents = await fs.readFile(filename, 'utf8');
    let manifest;
    try { manifest = validateBuiltinManifest(JSON.parse(contents)); }
    catch (error) { throw new BuiltinCatalogFailure(error instanceof SyntaxError ? 'Некорректный JSON в manifest.json.' : 'Описание manifest.json не соответствует формату встроенного каталога. Проверьте закреплённые ревизии, URL release и описи архивов.'); }
    if (flags[0] === '--dry-run' || flags[0] === '--download-only') {
        console.log(JSON.stringify(await syncBuiltinCatalog(manifest, { dryRun: flags[0] === '--dry-run', downloadOnly: flags[0] === '--download-only' })));
        return;
    }
    const connectionString = process.env.CATALOG_PG_URL || (process.env.CATALOG_PG_URL_FILE ? (await fs.readFile(process.env.CATALOG_PG_URL_FILE, 'utf8')).trim() : '');
    if (!connectionString) { throw new BuiltinCatalogFailure('Укажите CATALOG_PG_URL или CATALOG_PG_URL_FILE.'); }
    process.env.CATALOG_PG_URL = connectionString;
    const catalog = new CatalogDb(connectionString), devices = new DeviceStore({} as AccessDb);
    const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000 });
    try {
        await catalog.setup(); await devices.onModuleInit();
        const result = await syncBuiltinCatalog(manifest, { pool, skipConflicts: flags[0] === '--skip-conflicts' });
        if ('conflicts' in result) { for (const warning of builtinCatalogWarnings(result.conflicts ?? [])) { console.error(warning); } }
        console.log(JSON.stringify(result));
    } finally { await Promise.all([catalog.close(), devices.onModuleDestroy(), pool.end()]); }
}
void main().catch(error => {
    console.error(builtinCatalogError(error));
    process.exitCode = 1;
});
