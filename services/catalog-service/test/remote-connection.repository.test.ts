import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { modelFromRow, saveModelVersion, type IModelRow } from '../src/models/model-history';
import { RemoteConnectionRepository } from '../src/models/remote-connection.repository';
import { remoteConnectionInput, remoteVerificationDigest } from '../src/models/remote-model-validation';
import type { IModel } from '../src/models/model.types';
import type {IRemoteConnectionInput} from '../src/models/remote-model.types';

const connection = process.env.CATALOG_TEST_PG_URL;
const databases: Array<{ pool: Pool; admin: Pool; name: string }> = [];
const authorize = async () => undefined;
async function fixture() {
    const url = new URL(connection!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Only disposable localhost databases');
    url.pathname = '/postgres';
    const admin = new Pool({ connectionString: url.href, max: 1 }), name = 'nc_remote_options_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE ' + name); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: url.href, max: 4 }); databases.push({ pool, admin, name });
    await ensureCatalogSchema(pool);
    const descriptor = { runtime: 'remote-ollama', capability: 'chat', description: '', model: 'test-model', modelVersion: '2026-10',
        dimension: null, manifestSha256: null, verificationSha256: null, source: 'custom' };
    const row = (await pool.query<IModelRow>("INSERT INTO model_catalog(id,name,descriptor) VALUES('fixture-model','Fixture',$1::jsonb) RETURNING *", [JSON.stringify(descriptor)])).rows[0];
    await saveModelVersion(pool, row);
    const environment = { NEUROCENTER_MODEL_CREDENTIAL_KEY: randomBytes(32).toString('base64'), NEUROCENTER_REMOTE_MODEL_FIXTURE: 'env-secret' };
    return { pool, repository: new RemoteConnectionRepository(pool, environment), model: modelFromRow(row) };
}
/** Historical repository seed only: the public provider API now rejects shared key/env writes. */
const input = (model: IModel, revision: number, patch: Record<string, unknown> = {}):IRemoteConnectionInput => {
    const {credential='stored',apiKey='provider-fixture-secret',credentialEnv,...publicOptions}=patch;
    return {...remoteConnectionInput({expectedRevision:revision,expectedModelRevision:model.revision,baseUrl:'http://127.0.0.1:11434',requestDimensions:false,authMode:'required',...publicOptions}),
        credential:credential as IRemoteConnectionInput['credential'],...(Object.prototype.hasOwnProperty.call(patch,'apiKey')&&patch.apiKey===undefined?{}:{apiKey:apiKey as string}),...(credentialEnv?{credentialEnv:String(credentialEnv)}:{})};
};
const read = async (pool: Pool) => modelFromRow((await pool.query<IModelRow>("SELECT * FROM model_catalog WHERE id='fixture-model'")).rows[0]);
afterEach(async () => { for (const { pool, admin, name } of databases.splice(0)) { await pool.end(); await admin.query('DROP DATABASE ' + name); await admin.end(); } });

describe.skipIf(!connection)('Private model connection history — disposable PostgreSQL', () => {
    it('Persists defaults privately, fences edits, and keeps the old project pin on its old options', async () => {
        const { pool, repository, model } = await fixture();
        const first = await repository.save(model.id, input(model, 0, { options: { temperature: 0.5, contextWindow: 65536 }, timeoutMs: 120000 }), 'fixture', authorize);
        expect(first).toMatchObject({ revision: 1, modelRevision: model.revision, options: { temperature: 0.5, contextWindow: 65536 }, timeoutMs: 120000, hasKey: true, verified: false });
        expect(JSON.stringify(first)).not.toContain('provider-fixture-secret');
        const firstRow = (await repository.head(model.id))!, original = structuredClone(firstRow);
        expect(JSON.stringify(firstRow.credential)).not.toContain('provider-fixture-secret');
        const digest = remoteVerificationDigest(model, repository.connection(firstRow), null);
        const verified = await repository.verify(model, 1, digest, null, 'fixture', authorize);
        expect(verified.verificationSha256).toBe(digest);
        expect(verified).not.toHaveProperty('options'); expect(verified).not.toHaveProperty('apiKey');
        await expect(repository.save(model.id, input(model, 1), 'fixture', authorize)).rejects.toThrow('изменились');
        const second = await repository.save(model.id, input(verified, 1, { apiKey: undefined, options: { temperature: 0.1 }, timeoutMs: 300000 }), 'fixture', authorize);
        expect(second.revision).toBe(2);
        expect(second.modelRevision).toBe(verified.revision + 1);
        const secondRow = (await repository.head(model.id))!;
        expect(repository.connection(secondRow).apiKey).toBe('provider-fixture-secret');
        const current = await read(pool), nextDigest = remoteVerificationDigest(current, repository.connection(secondRow), null);
        expect(nextDigest).not.toBe(digest);
        await repository.verify(current, 2, nextDigest, null, 'fixture', authorize);
        expect((await repository.pinned(verified)).revision).toBe('1');
        expect(repository.connection(await repository.pinned(verified)).options).toEqual({ temperature: 0.5, contextWindow: 65536 });
        const retained = (await pool.query('SELECT * FROM model_remote_connections WHERE model_id=$1 AND revision=1', [model.id])).rows[0];
        expect({ ...retained, semantic_sha: null, verified_at: null }).toEqual(original);
    });
    it('Clones options on a changed semantic pin while retaining shared ciphertext only on its historical row', async () => {
        const { pool, repository, model } = await fixture();
        await repository.save(model.id, input(model, 0, { options: { topP: 0.8, maxOutputTokens: 8192 }, timeoutMs: 110000 }), 'fixture', authorize);
        const row = (await repository.head(model.id))!, digest = remoteVerificationDigest(model, repository.connection(row), null);
        const checked = await repository.verify(model, 1, digest, null, 'fixture', authorize);
        const revisedRow = (await pool.query<IModelRow>("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{modelVersion}','\"2027\"'),revision=revision+1 WHERE id=$1 RETURNING *", [model.id])).rows[0];
        await saveModelVersion(pool, revisedRow); const revised = modelFromRow(revisedRow);
        await repository.verify(revised, 1, remoteVerificationDigest(revised, repository.connection(row), null), null, 'fixture', authorize);
        const cloned = (await repository.head(model.id))!;
        expect(cloned.revision).toBe('2'); expect(cloned.options).toEqual(row.options); expect(cloned.timeout_ms).toBe(110000);
        expect(cloned.credential).toBeNull();expect(cloned.auth_mode).toBe('required');expect(repository.connection(cloned).apiKey).toBeUndefined();
        expect(repository.connection(row).apiKey).toBe('provider-fixture-secret');
        expect((await repository.pinned(checked)).revision).toBe('1');
    });
    it('Rejects unsupported options, invalid timeout, auth changes without a new key and failed authorization atomically', async () => {
        const { pool, repository, model } = await fixture();
        await pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{runtime}','\"remote-openai\"') WHERE id=$1", [model.id]);
        expect(() => input(model, 0, { options: { contextWindow: 127 } })).toThrow('contextWindow');
        await expect(repository.save(model.id, { ...input(model, 0), timeoutMs: 500 }, 'fixture', authorize)).rejects.toThrow('Таймаут');
        await expect(repository.save(model.id, input(model, 0), 'fixture', async () => { throw Error('revoked'); })).rejects.toThrow('revoked');
        expect(await repository.head(model.id)).toBeNull();
        await repository.save(model.id, input(model, 0, { credential: 'environment', apiKey: undefined, credentialEnv: 'NEUROCENTER_REMOTE_MODEL_FIXTURE' }), 'fixture', authorize);
        expect(repository.view(model.id, await repository.head(model.id), model.revision)).toMatchObject({ hasKey: true, credential: 'environment' });
        await expect(repository.save(model.id, input(model, 1, { apiKey: undefined }), 'fixture', authorize)).rejects.toThrow('Введите API-ключ');
        expect((await repository.head(model.id))?.revision).toBe('1');
        await expect(pool.query("UPDATE model_remote_connections SET options='[]'")).rejects.toThrow();
        await expect(pool.query('UPDATE model_remote_connections SET timeout_ms=999')).rejects.toThrow();
    });
    it('Stores a declared OpenAI context budget without pretending it changes the provider window', async () => {
        const {pool,repository,model}=await fixture();
        await pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{runtime}','\"remote-openai\"') WHERE id=$1",[model.id]);
        const saved=await repository.save(model.id,input(model,0,{options:{contextWindow:32768}}),'fixture',authorize);
        expect(saved.options).toEqual({contextWindow:32768});
        expect(repository.connection((await repository.head(model.id))!).options).toEqual({contextWindow:32768});
    });
});
