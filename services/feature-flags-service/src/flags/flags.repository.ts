import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, type FeatureFlagKey, type FeatureFlagValues, type IFeatureFlag } from '../../../shared/feature-flags.cjs';
import { featureFlagKey, featureFlagPatch } from './flag-validation';
import {migrateFeatureFlags} from '../database/migrations';

interface IFlagRow { flag_key: FeatureFlagKey; overrides: unknown; revision: number | string; updated_at: Date | string; updated_by: string }

function flag(row: IFlagRow): IFeatureFlag {
    const definition = FEATURE_FLAGS.find(item => item.key === row.flag_key);
    const overrides = row.overrides as { enabled?: unknown } | null;
    const revision = Number(row.revision);
    if (!definition || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)
        || Object.keys(overrides).some(key => key !== 'enabled') || overrides.enabled !== undefined && typeof overrides.enabled !== 'boolean'
        || !Number.isSafeInteger(revision) || revision < 1) { throw new Error('Некорректная запись переключателя.'); }
    const { defaultEnabled, ...metadata } = definition;
    return { ...metadata, enabled: overrides.enabled === undefined ? defaultEnabled : overrides.enabled as boolean,
        revision, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by };
}

/** Сервис владеет только своей таблицей; общий журнал готовится под той же блокировкой, что в каталоге. */
export class FlagsRepository {
    constructor(private readonly pool: Pool) {}

    async setup(): Promise<void> {
        await migrateFeatureFlags(this.pool);
        const client = await this.pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:catalog:migrations',0))");
            for (const item of FEATURE_FLAGS) {
                await client.query('INSERT INTO feature_flags(flag_key) VALUES($1) ON CONFLICT(flag_key) DO NOTHING', [item.key]);
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(() => { discard = true; }); throw error; }
        finally { if (discard) client.release(true); else client.release(); }
    }

    async list(): Promise<IFeatureFlag[]> {
        const result = await this.pool.query<IFlagRow>('SELECT * FROM feature_flags WHERE flag_key=ANY($1::text[])', [FEATURE_FLAG_KEYS]);
        return FEATURE_FLAGS.map(definition => {
            const row = result.rows.find(item => item.flag_key === definition.key);
            if (!row) { throw new Error('Переключатель отсутствует в хранилище.'); }
            return flag(row);
        });
    }

    async evaluated(): Promise<FeatureFlagValues> {
        return Object.fromEntries((await this.list()).map(item => [item.key, item.enabled])) as FeatureFlagValues;
    }

    async patch(key: unknown, raw: unknown, authorize: () => Promise<string>): Promise<IFeatureFlag> {
        const id = featureFlagKey(key), body = featureFlagPatch(raw);
        const client = await this.pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            const result = await client.query<IFlagRow>('SELECT * FROM feature_flags WHERE flag_key=$1 FOR UPDATE', [id]);
            if (!result.rows[0]) { throw new Error('Переключатель отсутствует в хранилище.'); }
            const current = flag(result.rows[0]);
            // Права перечитываются после ожидания блокировки, непосредственно перед сохранением.
            const actor = await authorize();
            if (current.revision !== body.expectedRevision) { throw new ConflictException('Переключатель уже изменили. Обновите список перед сохранением.'); }
            if (current.enabled === body.enabled) { await client.query('COMMIT'); return current; }
            const updated = await client.query<IFlagRow>(`UPDATE feature_flags SET overrides=jsonb_build_object('enabled',$2::boolean),
                revision=revision+1,updated_at=now(),updated_by=$3 WHERE flag_key=$1 RETURNING *`, [id, body.enabled, actor]);
            const saved = flag(updated.rows[0]);
            await client.query('INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',
                [randomUUID(), actor, 'feature_flag.update', id, JSON.stringify(current), JSON.stringify(saved)]);
            await client.query('COMMIT');
            return saved;
        } catch (error) { await client.query('ROLLBACK').catch(() => { discard = true; }); throw error; }
        finally { if (discard) client.release(true); else client.release(); }
    }
}
