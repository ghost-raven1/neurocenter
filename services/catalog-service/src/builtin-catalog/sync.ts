import type { Pool, PoolClient } from 'pg';
import { PluginRepository } from '../publication/plugin-repository';
import { publicationHash } from '../publication/publication-validation';
import { RuntimeArtifacts, runtimeArtifactDirectory } from '../runtime-artifacts/runtime-artifacts';
import type { DeviceStore } from '../devices/device-store';
import type { IAiPlugin } from '../catalog/dto';
import { cacheBuiltinArtifacts } from './download';
import { validateBuiltinManifest } from './manifest';
import { builtinCardHash, planBuiltinTool, type IBuiltinReceipt } from './planning';

export interface IBuiltinSyncOptions { pool?: Pool; dryRun?: boolean; downloadOnly?: boolean; fetch?: typeof fetch }
const author = 'builtin-catalog';

/** Файлы готовы до новых карточек; квитанция и новая версия сохраняются одной транзакцией. */
export async function syncBuiltinCatalog(input: unknown, options: IBuiltinSyncOptions = {}) {
    const manifest = validateBuiltinManifest(input);
    if (options.dryRun) {
        return { ok: true, dryRun: true, release: manifest.release, tools: manifest.tools.map(tool => ({
            key: tool.key, name: tool.publication.name, targets: tool.artifacts.map(artifact => artifact.descriptor.target),
        })) };
    }
    const allArtifacts = manifest.tools.flatMap(tool => tool.artifacts);
    if (options.downloadOnly) {
        const cached = await cacheBuiltinArtifacts(allArtifacts, runtimeArtifactDirectory(), options.fetch);
        return { ok: true, dryRun: false, downloadOnly: true, release: manifest.release, artifacts: cached.size };
    }
    const pool = options.pool;
    if (!pool) { throw new Error('Нужно подключение каталога.'); }
    const lease = await pool.connect();
    let locked = false;
    let transaction = false;
    try {
        await lease.query("SELECT pg_advisory_lock(hashtextextended('neurocenter:builtin-catalog-sync',0))"); locked = true;
        await pool.query(`CREATE TABLE IF NOT EXISTS builtin_catalog_receipts (
            tool_key text PRIMARY KEY, asset_id text NOT NULL UNIQUE, release text NOT NULL,
            publication_hash text NOT NULL, card_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
        const repository = new PluginRepository(pool);
        const receipts = new Map((await pool.query<IBuiltinReceipt>('SELECT * FROM builtin_catalog_receipts')).rows.map(row => [row.tool_key, row]));
        const plans = [];
        for (const tool of manifest.tools) {
            const receipt = receipts.get(tool.key);
            const card = await repository.get(receipt?.asset_id ?? tool.publication.name);
            plans.push(planBuiltinTool(tool, card, receipt));
        }
        const cached = await cacheBuiltinArtifacts(allArtifacts, runtimeArtifactDirectory(), options.fetch);
        const importer = new RuntimeArtifacts({ pool } as unknown as DeviceStore);
        const imported = new Set<string>();
        for (const artifact of allArtifacts) {
            const { descriptor } = artifact;
            if (imported.has(descriptor.sha256)) { continue; }
            const { rows } = await pool.query('SELECT compressed_bytes,unpacked_bytes,files_count FROM bridge_runtime_artifacts WHERE sha256=$1', [descriptor.sha256]);
            if (rows[0]) {
                if (Number(rows[0].compressed_bytes) !== descriptor.compressedBytes || Number(rows[0].unpacked_bytes) !== descriptor.unpackedBytes || Number(rows[0].files_count) !== descriptor.filesCount) {
                    throw new Error('Существующий артефакт имеет другую опись.');
                }
            } else { await importer.importArchive(cached.get(descriptor.sha256)!, descriptor); }
            imported.add(descriptor.sha256);
        }
        // Блокировка публикаций короткая: скачивание и проверка архивов уже завершены.
        await lease.query('BEGIN'); transaction = true;
        await lease.query("SELECT pg_advisory_xact_lock(hashtextextended('publication:dependency-graph',0))");
        await lease.query('SELECT id FROM ai_plugins WHERE id=ANY($1::text[]) OR lower(name)=ANY($2::text[]) ORDER BY id FOR UPDATE',
            [plans.flatMap(plan => plan.current ? [plan.current.id] : []), plans.map(plan => plan.tool.publication.name.toLowerCase())]);
        // Под общей блокировкой конфликт отменяет весь выпуск, включая квитанции и аудит.
        for (const plan of plans) {
            const live = await repository.get(plan.current?.id ?? plan.tool.publication.name);
            if (live ? !plan.current || builtinCardHash(live) !== builtinCardHash(plan.current) : !!plan.current) {
                throw new Error(`«${plan.tool.publication.name}»: карточка изменилась во время подготовки. Повторите синхронизацию.`);
            }
        }
        const tools = [];
        for (const plan of plans) {
            const saveReceipt = async (client: PoolClient, card: IAiPlugin): Promise<void> => {
                await client.query(`INSERT INTO builtin_catalog_receipts(tool_key,asset_id,release,publication_hash,card_hash)
                    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tool_key) DO UPDATE SET asset_id=EXCLUDED.asset_id,
                    release=EXCLUDED.release,publication_hash=EXCLUDED.publication_hash,card_hash=EXCLUDED.card_hash,updated_at=now()`,
                [plan.tool.key, card.id, manifest.release, publicationHash(plan.tool.publication), builtinCardHash(card)]);
            };
            let card: IAiPlugin;
            if (!plan.current) { card = await repository.create(plan.tool.publication, author, saveReceipt, lease, true); }
            else if (plan.action === 'unchanged' && plan.receipt?.publication_hash === publicationHash(plan.tool.publication)) { card = plan.current; }
            else {
                const saved = await repository.update(plan.current.id, plan.patch!, author, saveReceipt, lease, true);
                if (!saved) { throw new Error('Карточка удалена во время синхронизации.'); }
                card = saved;
            }
            tools.push({ key: plan.tool.key, id: card.id, name: card.name, version: card.version, action: plan.action });
        }
        await lease.query('COMMIT'); transaction = false;
        return { ok: true, dryRun: false, release: manifest.release, tools };
    } catch (error) {
        if (transaction) { await lease.query('ROLLBACK'); }
        throw error;
    } finally {
        try { if (locked) { await lease.query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:builtin-catalog-sync',0))"); } }
        finally { lease.release(); }
    }
}
