import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import { modelFromRow, nextModelRevision, saveModelVersion, type IModelRow } from './model-history';
import type { IModel } from './model.types';
import { canStoreModelCredential, openModelCredential, sealModelCredential, type ISealedModelCredential } from './remote-model-secret';
import { isRemoteModel, type IRemoteConnectionInput, type IRemoteConnectionView, type IRemoteModelConnection } from './remote-model.types';
import { assertRemoteModelOptions, remoteModelOptions, remoteModelTimeout } from './remote-model-options';
import type { IRemoteModelOptions } from './remote-model.types';
import {providerFence,remoteAuthMode} from '../remote-providers/remote-provider.identity';

export interface IRemoteConnectionRow {
    model_id: string; revision: number | string; base_url: string; request_dimensions: boolean;
    options: IRemoteModelOptions; timeout_ms: number;
    auth_mode?:'none'|'optional'|'required'|null;
    credential_kind: 'none' | 'stored' | 'environment'; credential: ISealedModelCredential | null; credential_env: string | null;
    semantic_sha: string | null; verified_at: string | Date | null; failure_message: string | null; revoked_at: string | Date | null;
}
type Db = Pick<PoolClient, 'query'>;
const iso = (value: Date | string | null): string | null => value ? new Date(value).toISOString() : null;
const changed = () => new ConflictException('Подключение или карточка модели изменились. Обновите данные перед повторной проверкой.');

/** Исторические конфигурации выбираются по semantic pin, ключи доступны только исполнителю inference. */
export class RemoteConnectionRepository {
    constructor(private readonly pool: Pool, private readonly environment: NodeJS.ProcessEnv = process.env) {}
    async head(id: string, db: Db = this.pool): Promise<IRemoteConnectionRow | null> {
        const result = await db.query<IRemoteConnectionRow>('SELECT * FROM model_remote_connections WHERE model_id=$1 ORDER BY revision DESC LIMIT 1', [id]);
        return result.rows[0] ?? null;
    }
    view(id: string, row: IRemoteConnectionRow | null, modelRevision: number): IRemoteConnectionView {
        const active = row && !row.revoked_at;
        return { modelId: id, modelRevision, authMode:active?remoteAuthMode(row):'required', revision: Number(row?.revision ?? 0), baseUrl: active ? row.base_url : '', requestDimensions: !!active && row.request_dimensions,
            options: active ? remoteModelOptions(row.options) : {}, timeoutMs: active ? remoteModelTimeout(row.timeout_ms) : remoteModelTimeout(undefined),
            credential: active ? row.credential_kind : 'none', credentialEnv: active ? row.credential_env : null,
            hasKey: !!active && (row.credential_kind === 'stored' || row.credential_kind === 'environment' && !!this.environment[row.credential_env!]),
            checkedAt: active ? iso(row.verified_at) : null, verified: !!active && !!row.semantic_sha && !row.failure_message,
            canStoreKey: canStoreModelCredential(this.environment) };
    }
    connection(row: IRemoteConnectionRow): IRemoteModelConnection {
        if (row.revoked_at) throw new ServiceUnavailableException('Подключение модели отозвано. Выберите другое подключение.');
        const key = row.credential_kind === 'stored' ? openModelCredential(row.credential!, row.model_id, Number(row.revision), this.environment)
            : row.credential_kind === 'environment' ? this.environment[row.credential_env!] : undefined;
        if (row.credential_kind !== 'none' && !key) throw new ServiceUnavailableException('API-ключ модели не настроен. Обратитесь к главному администратору.');
        if (key && (key.length > 8192 || /[\x00-\x20\x7f]/.test(key))) throw new ServiceUnavailableException('API-ключ модели некорректен. Обратитесь к главному администратору.');
        return { modelId: row.model_id, revision: Number(row.revision), baseUrl: row.base_url, requestDimensions: row.request_dimensions,
            options: remoteModelOptions(row.options), timeoutMs: remoteModelTimeout(row.timeout_ms), ...(key ? { apiKey: key } : {}) };
    }
    async pinned(model: IModel): Promise<IRemoteConnectionRow> {
        if (!model.verificationSha256) throw new ConflictException('Подключение модели ещё не проверено.');
        const result = await this.pool.query<IRemoteConnectionRow>(`SELECT * FROM model_remote_connections
            WHERE model_id=$1 AND semantic_sha=$2 AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1`, [model.id, model.verificationSha256]);
        if (!result.rows[0]) throw new ServiceUnavailableException('Закреплённое подключение модели недоступно или отозвано.');
        return result.rows[0];
    }
    async save(id: string, input: IRemoteConnectionInput, actor: string, authorize: () => Promise<unknown>): Promise<IRemoteConnectionView> {
        return this.transaction(async db => {
            await this.providerWriteFence(db,id);
            const model = await this.lockModel(db, id); await authorize();
            const previous = await this.head(id, db);
            if (model.revision !== input.expectedModelRevision || Number(previous?.revision ?? 0) !== input.expectedRevision) throw changed();
            if (model.archivedAt) throw new ConflictException('Модель убрана из общего каталога. Настройки исторической версии сохранены.');
            const options = remoteModelOptions(input.options), timeoutMs = remoteModelTimeout(input.timeoutMs);
            assertRemoteModelOptions(model, options);
            const revision = Number(previous?.revision ?? 0) + 1;
            if (!Number.isSafeInteger(revision)) throw changed();
            let secret: ISealedModelCredential | null = null;
            if (input.credential === 'stored') {
                const key = input.apiKey ?? (previous && !previous.revoked_at && previous.credential_kind === 'stored'
                    ? this.connection(previous).apiKey : undefined);
                if (!key) throw new BadRequestException('Введите API-ключ для нового подключения.');
                secret = sealModelCredential(key, id, revision, this.environment);
            }
            const result = await db.query<IRemoteConnectionRow>(`INSERT INTO model_remote_connections
                (model_id,revision,base_url,request_dimensions,credential_kind,credential,credential_env,options,timeout_ms,auth_mode)
                VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10) RETURNING *`,
            [id, revision, input.baseUrl, input.requestDimensions, input.credential, secret ? JSON.stringify(secret) : null, input.credentialEnv ?? null, JSON.stringify(options), timeoutMs,input.authMode??(input.credential==='none'?'none':'required')]);
            // Новая конфигурация проверяется отдельно; активные проекты читают прежний immutable pin.
            const savedModel = await this.pin(db, model, null, model.dimension);
            await securityEvent(db, { actor, action: 'model.connection.update', resourceId: id,
                before: previous ? this.audit(previous) : null, after: this.audit(result.rows[0]) });
            return this.view(id, result.rows[0], savedModel.revision);
        });
    }
    async verify(expected: IModel, connectionRevision: number, digest: string, dimension: number | null, actor: string, authorize: () => Promise<unknown>): Promise<IModel> {
        return this.transaction(async db => {
            await this.providerWriteFence(db,expected.id);
            const current = await this.lockModel(db, expected.id); await authorize();
            const head = await this.head(expected.id, db);
            if (current.revision !== expected.revision || current.archivedAt || !head || head.revoked_at || Number(head.revision) !== connectionRevision) throw changed();
            let verifiedRevision=connectionRevision;
            if(head.semantic_sha&&head.semantic_sha!==digest){
                verifiedRevision=connectionRevision+1;if(!Number.isSafeInteger(verifiedRevision))throw changed();
                // The old checked pin keeps its ciphertext; the new revision requires its own AAD.
                // The legacy shared ciphertext stays on its historical row, without copying it into new calls.
                await db.query(`INSERT INTO model_remote_connections
                    (model_id,revision,base_url,request_dimensions,credential_kind,credential,credential_env,semantic_sha,verified_at,options,timeout_ms,auth_mode)
                    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now(),$9::jsonb,$10,$11)`,
                [expected.id,verifiedRevision,head.base_url,head.request_dimensions,'none',null,null,digest,JSON.stringify(head.options),head.timeout_ms,remoteAuthMode(head)]);
            }else await db.query('UPDATE model_remote_connections SET semantic_sha=$3,verified_at=now(),failure_message=NULL WHERE model_id=$1 AND revision=$2', [expected.id, connectionRevision, digest]);
            const saved = await this.pin(db, current, digest, dimension);
            await securityEvent(db, { actor, action: 'model.connection.verify', resourceId: current.id,
                before: { modelRevision: current.revision }, after: { modelRevision: saved.revision, connectionRevision:verifiedRevision, verificationSha256: digest, dimension } });
            return saved;
        });
    }
    async revoke(id: string, expectedModelRevision: number, expectedRevision: number, actor: string, authorize: () => Promise<unknown>): Promise<void> {
        await this.transaction(async db => {
            await this.providerWriteFence(db,id);
            const current = await this.lockModel(db, id); await authorize(); const head = await this.head(id, db);
            if (current.revision !== expectedModelRevision || Number(head?.revision ?? 0) !== expectedRevision) throw changed();
            if (!head || head.revoked_at) return;
            const projects = await db.query<{ id: string; name: string }>(`SELECT p.id,p.name FROM project_embedding_settings e JOIN projects p ON p.id=e.project_id WHERE e.model_id=$1 ORDER BY p.name`, [id]);
            if (projects.rows.length) throw new ConflictException({ message: 'Подключение используется для поиска. Сначала переключите embedding-модель этих проектов.', projects: projects.rows });
            await db.query('UPDATE model_remote_connections SET revoked_at=now() WHERE model_id=$1 AND revoked_at IS NULL', [id]);
            await this.pin(db, current, null, current.dimension);
            await securityEvent(db, { actor, action: 'model.connection.revoke', resourceId: id, before: { revision: Number(head.revision) }, after: { revoked: true } });
        });
    }
    /** Health is optional: bound checkout plus SQL, discard only our waiting client, and return a late checkout unused. */
    async failure(row: IRemoteConnectionRow, message: string | null): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            let client: PoolClient | undefined, expired = false, released = false;
            const release = (destroy = false) => { if (client && !released) { released = true; client.release(destroy); } };
            const timer = setTimeout(() => { expired = true; release(true); reject(new Error('Remote health write deadline exceeded')); }, 500);
            Promise.resolve().then(() => this.pool.connect()).then(async db => {
                if (expired) { db.release(); return; }
                client = db;
                try {
                    await db.query('BEGIN');
                    await db.query("SET LOCAL statement_timeout='250ms'; SET LOCAL lock_timeout='150ms'");
                    await db.query('UPDATE model_remote_connections SET failure_message=$3 WHERE model_id=$1 AND revision=$2 AND revoked_at IS NULL', [row.model_id, row.revision, message]);
                    await db.query('COMMIT');
                    resolve();
                } catch (error) { release(true); reject(error); }
                finally { clearTimeout(timer); release(); }
            }, error => { clearTimeout(timer); reject(error); });
        });
    }
    private audit(row: IRemoteConnectionRow) {
        // Arbitrary private JSON, URL, env values and ciphertext never enter the shared audit.
        const { providerParameters, ...options } = remoteModelOptions(row.options);
        return { revision: Number(row.revision), credential: row.credential_kind, hasKey: row.credential_kind !== 'none', requestDimensions: row.request_dimensions,
            options, providerParameterCount: Object.keys(providerParameters ?? {}).length, timeoutMs: row.timeout_ms };
    }
    private async pin(db: Db, current: IModel, digest: string | null, dimension: number | null): Promise<IModel> {
        if ((current.verificationSha256 ?? null) === digest && current.dimension === dimension) return current;
        const { id: _id, name: _name, revision: _revision, createdAt: _created, updatedAt: _updated, archivedAt: _archived, modelPin: _pin, ...descriptor } = current;
        const revision=await nextModelRevision(db,current.id,current.revision);
        const result = await db.query<IModelRow>('UPDATE model_catalog SET descriptor=$2::jsonb,revision=$3,updated_at=now() WHERE id=$1 RETURNING *',
            [current.id, JSON.stringify({ ...descriptor, verificationSha256: digest, dimension }),revision]);
        await saveModelVersion(db, result.rows[0]); return modelFromRow(result.rows[0]);
    }
    private async lockModel(db: Db, id: string): Promise<IModel> {
        const result = await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id]);
        if (!result.rows[0]) throw new NotFoundException('Модель отсутствует в каталоге.');
        const model = modelFromRow(result.rows[0]);
        if (!isRemoteModel(model)) throw new BadRequestException('Эта модель использует управляемый серверный runtime.');
        return model;
    }
    private async providerWriteFence(db:Db,id:string):Promise<void>{
        await db.query('SELECT pg_advisory_xact_lock_shared(72465381)');
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[providerFence(id)]);
    }
    private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
        catch (cause) { await db.query('ROLLBACK').catch(() => undefined); throw cause; }
        finally { db.release(); }
    }
}
