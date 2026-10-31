import { ConflictException } from '@nestjs/common';
import { assertIndexEvolution } from '@neurocenter/asset-contract';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import { authorizeImportActor } from './import-worker';
import type { ISourceSnapshot } from './source-snapshots';
import { bridgeSourceUrl } from './bridge-source-feed';

export interface IBridgeSourceSettings {
    url: string;
    revision: number;
    checked_at: Date | null;
    attempted_at: Date | null;
    check_token: string | null;
    check_commit: string | null;
    error: string | null;
    installed_repository: string | null;
    installed_asset_id: string | null;
}
export const staleBridgeSource = () =>
    new ConflictException('Источник или проверка моста изменились. Обновите данные и повторите действие.');

/** The source revision fences URL edits and late checks; immutable graphs are scoped by repository and commit. */
export class BridgeSourceRepository {
    constructor(readonly pool: Pool) {}
    async settings(db: Pick<Pool, 'query'> = this.pool, lock = false): Promise<IBridgeSourceSettings> {
        const row = (
            await db.query<IBridgeSourceSettings>(
                'SELECT * FROM bridge_source_settings WHERE singleton' + (lock ? ' FOR UPDATE' : ''),
            )
        ).rows[0];
        if (!row) throw new Error('Настройки источника моста не созданы миграцией.');
        return row;
    }
    async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await operation(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
    async save(actor: string, url: string, revision: number): Promise<void> {
        await this.transaction(async (client) => {
            await authorizeImportActor(client, actor, true);
            const current = await this.settings(client, true);
            if (current.revision !== revision) throw staleBridgeSource();
            if (current.url === url) return;
            await client.query(
                `UPDATE bridge_source_settings SET url=$1,revision=revision+1,checked_at=NULL,attempted_at=NULL,
                check_token=NULL,check_commit=NULL,error=NULL,updated_by=$2,updated_at=now() WHERE singleton`,
                [url, actor],
            );
            await securityEvent(client, {
                actor,
                action: 'bridge.source.update',
                resourceId: 'bridge-source',
                before: { url: current.url, revision },
                after: { url, revision: revision + 1 },
            });
        });
    }
    async begin(revision: number, force: boolean): Promise<{ settings: IBridgeSourceSettings; token?: string }> {
        return this.transaction(async (client) => {
            const settings = await this.settings(client, true);
            if (settings.revision !== revision) throw staleBridgeSource();
            const age = (date: Date | null) => (date ? Date.now() - new Date(date).getTime() : Infinity);
            // Failed or in-flight checks have a short retry cooldown; automatic successful checks use a five-minute cache.
            if (age(settings.attempted_at) < 15000 || (!force && !settings.error && age(settings.checked_at) < 300000))
                return { settings };
            const token = randomUUID();
            await client.query('UPDATE bridge_source_settings SET attempted_at=now(),check_token=$1 WHERE singleton', [
                token,
            ]);
            return { settings, token };
        });
    }
    async snapshot(
        repository: string,
        commit: string,
        db: Pick<Pool, 'query'> = this.pool,
    ): Promise<ISourceSnapshot | undefined> {
        return (
            await db.query<ISourceSnapshot>('SELECT * FROM bridge_source_checks WHERE repository=$1 AND commit=$2', [
                repository,
                commit,
            ])
        ).rows[0];
    }
    async checked(settings: IBridgeSourceSettings, token: string, snapshot: ISourceSnapshot): Promise<void> {
        await this.transaction(async (client) => {
            const current = await this.settings(client, true);
            if (current.revision !== settings.revision || current.url !== settings.url || current.check_token !== token)
                throw staleBridgeSource();
            const previous = (
                await client.query<ISourceSnapshot>('SELECT * FROM bridge_source_checks WHERE repository=$1', [
                    snapshot.pin.repository,
                ])
            ).rows;
            try {
                for (const item of previous) {
                    assertIndexEvolution(item.index, snapshot.index);
                    if (item.pin.commit === snapshot.pin.commit && item.pin.index.sha256 !== snapshot.pin.index.sha256)
                        throw new Error();
                }
            } catch {
                throw new ConflictException(
                    'Источник переписал или удалил опубликованную историю. Проверка моста отклонена.',
                );
            }
            await client.query(
                `INSERT INTO bridge_source_checks(repository,commit,pin,index,assets) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)
                ON CONFLICT(repository,commit) DO UPDATE SET checked_at=now()`,
                [
                    snapshot.pin.repository,
                    snapshot.pin.commit,
                    JSON.stringify(snapshot.pin),
                    JSON.stringify(snapshot.index),
                    JSON.stringify(snapshot.assets),
                ],
            );
            await client.query(
                'UPDATE bridge_source_settings SET checked_at=now(),check_commit=$1,error=NULL WHERE singleton',
                [snapshot.pin.commit],
            );
        });
    }
    async failed(settings: IBridgeSourceSettings, token: string, message: string): Promise<void> {
        await this.pool.query(
            'UPDATE bridge_source_settings SET error=$1 WHERE singleton AND revision=$2 AND url=$3 AND check_token=$4',
            [message.slice(0, 1000), settings.revision, settings.url, token],
        );
    }
}

export const bridgeSourceRepository = (url: string) => bridgeSourceUrl(url).slice('https://github.com/'.length);
