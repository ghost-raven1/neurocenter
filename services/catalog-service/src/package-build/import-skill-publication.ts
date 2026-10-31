import type { Pool } from 'pg';
import type { SkillAsset } from '@neurocenter/asset-contract';
import type { AssetSourcesService } from '../asset-sources/asset-sources.service';
import { authorizeImportActor } from '../asset-sources/import-worker';

/** Native skill journal is preserved; an uncertain SQL rollback never returns its session to the pool. */
export async function importBuiltSkill(
    pool: Pool,
    sources: AssetSourcesService,
    asset: SkillAsset,
    requestKey: string,
    actor: string,
    guard: () => Promise<void>,
    notify: () => Promise<void>,
) {
    const prepared = await sources.prepareLocalSkill(asset, requestKey);
    await guard();
    const client = await pool.connect();
    let tainted = false;
    try {
        await client.query('BEGIN');
        await guard();
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            'asset-management:skill:common/' + asset.card.slug,
        ]);
        await authorizeImportActor(client, actor, true);
        await guard();
        const native = await sources.publishLocalSkill(prepared, actor);
        await guard();
        const source = await sources.recordLocalSkill(client, prepared, native, actor);
        await guard();
        await client.query('COMMIT');
        await notify();
        return {
            catalogId: native.id,
            name: asset.card.name,
            version: native.version,
            kind: 'skill' as const,
            ...source,
        };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            tainted = true;
        }
        throw error;
    } finally {
        if (tainted) client.release(true);
        else client.release();
    }
}
