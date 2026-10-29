import 'reflect-metadata';
import { createHash,randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { OpenCodeModelSyncService } from '../src/models/opencode-model-sync.service';
import { OPENCODE_MODEL_SYNC_SCHEMA_SQL } from '../src/models/opencode-model-sync.schema';
import { assertOpenCodeModelSyncSchema } from '../src/models/opencode-model-sync.schema-verification';
import { ModelsRepository } from '../src/models/models.repository';
import { RemoteConnectionRepository } from '../src/models/remote-connection.repository';
import type { ModelsService } from '../src/models/models.service';
import type { Device, DeviceStore } from '../src/devices/device-store';
import { modelScanDigest, type IOpenCodeModelCandidate, type IOpenCodeModelScan } from '../../shared/opencode-model-scan.cjs';
import {saveModelVersion} from '../src/models/model-history';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {sealModelCredential} from '../src/models/remote-model-secret';
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));

const adminUrl = process.env.OPENCODE_MODEL_SYNC_TEST_PG_URL;
describe.skipIf(!adminUrl).sequential('OpenCode auto-sync — isolated PostgreSQL and no paid provider calls', () => {
    let admin: Pool, pool: Pool, database: string, service: OpenCodeModelSyncService, modelRepo: ModelsRepository, remote: RemoteConnectionRepository;
    let device: Device, roleAllowed = true;
    const project = 'prj-opencode-sync', bindingId = 'a'.repeat(64), instanceId = randomUUID();
    const request = {} as Request, secret = 'qa-secret-' + randomUUID();
    const candidate = (patch: Partial<IOpenCodeModelCandidate> = {}): IOpenCodeModelCandidate => ({ candidateId: randomUUID(), configKey: 'alias', provider: 'team', name: 'Team model', model: 'upstream-chat', modelVersion: 'upstream-chat', capability: 'chat', runtime: 'remote-openai', baseUrl: 'https://provider.example.test/v1', hasKey: true, credentialSource: 'inline', blocker: null, options: { temperature: 0, contextWindow: 128000 }, outputTokenLimit: 64000, ...patch });
    const snapshot = (candidates = [candidate()], warnings: string[] = []): IOpenCodeModelScan => {
        const now = new Date(), scan: IOpenCodeModelScan = { schemaVersion: 2, scope: 'project', projectId: project, bindingId, instanceId, scanId: randomUUID(), checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString(), candidates, warnings, digest: '' };
        scan.digest = modelScanDigest(scan); return scan;
    };
    const identity = async (): Promise<Device> => (await pool.query('SELECT * FROM bridge_devices WHERE id=$1', [device.id])).rows[0];
    const sync = (scan: IOpenCodeModelScan, credentials = {}, settingsRevision = 0) => service.sync(device, { scan, credentials, settingsRevision }, identity);
    const cards = async () => (await pool.query('SELECT * FROM model_catalog')).rows;
    beforeAll(async () => {
        const url = new URL(adminUrl!); if (url.hostname !== '127.0.0.1' || !url.port || url.port === '5432') throw Error('Use an owned isolated PostgreSQL port.');
        database = 'nc_opencode_sync_' + randomUUID().replaceAll('-', ''); admin = new Pool({ connectionString: url.href, max: 1 });
        await admin.query('CREATE DATABASE ' + database); url.pathname = '/' + database; pool = new Pool({ connectionString: url.href, max: 5 });
        await ensureCatalogSchema(pool);
        if (!(await pool.query("SELECT to_regclass('opencode_model_sources') AS name")).rows[0].name) await pool.query(OPENCODE_MODEL_SYNC_SCHEMA_SQL);
        modelRepo = new ModelsRepository(pool); remote = new RemoteConnectionRepository(pool);
        const owned = async (actor: { email: string }, id: string): Promise<Device> => {
            const row = (await pool.query('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now()', [id, actor.email])).rows[0];
            if (!row) throw new ForbiddenException(); return row;
        };
        service = new OpenCodeModelSyncService({ pool, requireMain: async () => { if (!roleAllowed) throw new ForbiddenException(); return 'qa@example.test'; } } as unknown as ModelsService,
            { owned, access: { claims: async () => ({ userRoles: roleAllowed ? ['Главный админ'] : [], projects: [] }) } } as unknown as DeviceStore);
        vi.stubEnv('NEUROCENTER_MODEL_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    });
    beforeEach(async () => {
        roleAllowed = true; vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined); await pool.query('TRUNCATE projects,bridge_devices,model_catalog,security_events CASCADE');
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [project, 'OpenCode QA']);
        device = { id: randomUUID(), email: 'qa@example.test', role: 'Главный админ', name: 'QA computer', fingerprint: 'b'.repeat(64), last_seen: null, revoked: false, report: { capabilities:['opencode-model-sync-v2'],bindings: [{ projectId: project, folderName: 'qa', bindingId, instanceId }] } };
        await pool.query(`INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [device.id, device.email, device.role, device.name, device.fingerprint, randomBytes(32).toString('hex'), JSON.stringify(device.report)]);
    });
    afterAll(async () => { vi.unstubAllEnvs(); if (pool) await pool.end(); if (admin) { await admin.query('DROP DATABASE IF EXISTS ' + database); await admin.end(); } });

    const globalSnapshot = (candidates=[candidate()]):IOpenCodeModelScan=>{
        const project=snapshot(candidates),scan:IOpenCodeModelScan={schemaVersion:2,scope:'global',deviceId:device.id,scanId:project.scanId,checkedAt:project.checkedAt,expiresAt:project.expiresAt,candidates,warnings:[],digest:''};scan.digest=modelScanDigest(scan);return scan;
    };
    const oldManualImport=async(proven=true)=>{
        const source=candidate(),id='model-opencode-'+createHash('sha256').update(JSON.stringify([source.provider,source.runtime,source.model,source.modelVersion,source.baseUrl])).digest('hex').slice(0,40);
        const descriptor={description:'Previously imported',runtime:source.runtime,model:source.model,modelVersion:source.modelVersion,capability:source.capability,source:'custom',dimension:null,manifestSha256:null,verificationSha256:null};
        const row=(await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3) RETURNING *',[id,'Previous manual import',descriptor])).rows[0];await saveModelVersion(pool,row);
        await remote.save(id,{expectedModelRevision:1,expectedRevision:0,baseUrl:source.baseUrl!,requestDimensions:false,credential:'stored',apiKey:secret,options:source.options},device.email,async()=>undefined);
        if(proven)await pool.query('INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),device.email,'model.import.opencode',id,null,{provider:source.provider,model:source.model,runtime:source.runtime}]);
        return {id,source};
    };
    it('upgrade adopts a proven exact manual import once, then preserves manual edits through a durable identity alias',async()=>{
        const old=await oldManualImport();const before=await remote.head(old.id);await sync(snapshot([old.source]));expect(await cards()).toHaveLength(1);expect(await remote.head(old.id)).toEqual(before);
        expect((await service.repository.sources(device.id))[0]).toMatchObject({modelId:old.id,credentialStatus:'manual'});
        const model=(await modelRepo.get(old.id))!;await modelRepo.update(old.id,{expectedRevision:model.revision,name:'Keep my manual name'},device.email);
        const updated=(await modelRepo.get(old.id))!;await remote.save(old.id,{expectedModelRevision:updated.revision,expectedRevision:Number(before!.revision),baseUrl:'https://manually-edited.example.test/v1',requestDimensions:false,credential:'stored',options:{contextWindow:8192}},device.email,async()=>undefined);
        const manual=await remote.head(old.id);await sync(snapshot([candidate()]));expect(await cards()).toHaveLength(1);expect(await remote.head(old.id)).toEqual(manual);expect((await modelRepo.get(old.id))!.name).toBe('Keep my manual name');
        expect((await pool.query('SELECT model_id FROM opencode_model_identities')).rows).toEqual([{model_id:old.id}]);
    });
    it.each(['no-origin','archived','revoked','different-options'])('upgrade never adopts old import with %s or touches its key/history',async reason=>{
        const old=await oldManualImport(reason!=='no-origin');
        if(reason==='archived'){const model=(await modelRepo.get(old.id))!;await modelRepo.remove(old.id,{expectedRevision:model.revision},device.email);}
        if(reason==='revoked'){const model=(await modelRepo.get(old.id))!;await remote.revoke(old.id,model.revision,1,device.email,async()=>undefined);}
        const before=await remote.head(old.id),metadata=await modelRepo.get(old.id);
        await sync(snapshot([reason==='different-options'?candidate({options:{contextWindow:64000}}):old.source]));
        expect(await remote.head(old.id)).toEqual(before);expect(await modelRepo.get(old.id)).toEqual(metadata);
        expect((await pool.query('SELECT * FROM opencode_model_identities WHERE model_id=$1',[old.id])).rowCount).toBe(0);expect((await service.repository.sources(device.id))[0].modelId).not.toBe(old.id);
    });
    it('a disabled sync capability blocks context and snapshot without writes, and is rechecked inside the transaction',async()=>{
        const denied=()=>new ForbiddenException({code:'feature-disabled',feature:'opencode_model_sync',message:'Синхронизация отключена'});
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(denied());
        await expect(service.context(device)).rejects.toHaveProperty('status',403);
        await expect(sync(snapshot())).rejects.toHaveProperty('status',403);expect(await cards()).toHaveLength(0);
        vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValueOnce(undefined).mockRejectedValue(denied());
        await expect(sync(snapshot())).rejects.toHaveProperty('status',403);expect(await cards()).toHaveLength(0);
        expect((await pool.query('SELECT * FROM opencode_model_sources')).rowCount).toBe(0);
    });
    it('global discovery works with no project or binding and never assigns an arbitrary project',async()=>{
        await pool.query('DELETE FROM projects');device.report.bindings=[];await pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[device.id,JSON.stringify(device.report)]);
        expect((await service.context(device)).global).toEqual({deviceId:device.id});expect((await service.context(device)).bindings).toEqual([]);
        await sync(globalSnapshot());expect(await cards()).toHaveLength(1);expect((await pool.query('SELECT * FROM project_models')).rows).toHaveLength(0);
        expect((await service.repository.sources(device.id))[0]).toMatchObject({scope:'global',projectId:null,assigned:false,state:'present'});
        const source=(await pool.query('SELECT * FROM opencode_model_sources')).rows[0];expect(source.binding_id).toBeNull();expect(source.instance_id).toBeNull();expect(source.scope_key).toBe('global');
        const foreign=globalSnapshot();foreign.deviceId=randomUUID();foreign.digest=modelScanDigest(foreign);await expect(sync(foreign)).rejects.toThrow('снимок');
    });
    it('equal global/project semantic options deduplicate; project overrides get their own card and exact context',async()=>{
        await sync(globalSnapshot());await sync(snapshot());expect(await cards()).toHaveLength(1);
        const globalModel=(await cards())[0];await sync(snapshot([candidate({options:{temperature:0.8,contextWindow:64000}})]));expect(await cards()).toHaveLength(2);
        const sources=await service.repository.sources(device.id),global=sources.find(row=>row.scope==='global'),projectSource=sources.find(row=>row.scope==='project');
        expect(global.modelId).toBe(globalModel.id);expect(projectSource.modelId).not.toBe(global.modelId);expect((await remote.head(global.modelId)).options).toEqual({temperature:0,contextWindow:128000});expect((await remote.head(projectSource.modelId)).options).toEqual({temperature:0.8,contextWindow:64000});
        await sync(globalSnapshot());await sync(snapshot([candidate({options:{contextWindow:64000,temperature:0.8}})]));expect(await cards()).toHaveLength(2);
    });
    it('global snapshot ordering and removals never clear a project source; incomplete global config is non-destructive',async()=>{
        await sync(snapshot());const old=globalSnapshot();old.checkedAt=new Date(Date.now()-10000).toISOString();old.expiresAt=new Date(Date.now()+890000).toISOString();old.digest=modelScanDigest(old);
        await sync(globalSnapshot([]));await expect(sync(old)).rejects.toThrow('устаревший');expect((await service.repository.sources(device.id)).find(row=>row.scope==='project').state).toBe('present');
        await sync(globalSnapshot());const invalid=globalSnapshot([]);invalid.warnings=['invalid-json'];invalid.digest=modelScanDigest(invalid);expect((await sync(invalid)).incomplete).toBe(true);expect((await service.repository.sources(device.id)).find(row=>row.scope==='global').state).toBe('present');
        await sync(globalSnapshot([]));const sources=await service.repository.sources(device.id);expect(sources.find(row=>row.scope==='global').state).toBe('missing');expect(sources.find(row=>row.scope==='project').state).toBe('present');
    });
    it('creates one linked card and ready-to-configure connection; context and output capacity remain distinct', async () => {
        const scan = snapshot(); expect((await sync(scan)).imported).toBe(1);
        const model = (await cards())[0], connection = await remote.head(model.id);
        expect(connection).toMatchObject({ options: { temperature: 0, contextWindow: 128000 }, credential_kind: 'none', semantic_sha: null });
        expect(connection?.options).not.toHaveProperty('maxOutputTokens');
        expect((await service.read(request, device.id)).sources[0]).toMatchObject({ modelId: model.id, contextWindow: 128000, outputTokenLimit: 64000, credentialStatus: 'pending', state: 'present', assigned: true, needsCheck: true, hasServerKey: false });
        expect((await sync(snapshot())).imported).toBe(0); expect(await cards()).toHaveLength(1); expect(Number((await remote.head(model.id))!.revision)).toBe(1);
    });
    it('ignores JSON option key order and provider failures; neither produces a new connection on every heartbeat', async () => {
        await sync(snapshot()); const model = (await cards())[0];
        await pool.query("UPDATE model_remote_connections SET failure_message='Provider unavailable' WHERE model_id=$1", [model.id]);
        await sync(snapshot([candidate({ options: { contextWindow: 128000, temperature: 0 } })]));
        expect(Number((await remote.head(model.id))!.revision)).toBe(1); expect((await remote.head(model.id))!.failure_message).toBe('Provider unavailable');
    });
    it('rejects credential snapshots before storage even when a historical export preference is enabled', async () => {
        for (const legacy of [false, true]) {
            await pool.query('INSERT INTO opencode_model_sync_settings(device_id,revision,enabled,transfer_credentials) VALUES($1,3,true,$2) ON CONFLICT(device_id) DO UPDATE SET transfer_credentials=$2', [device.id, legacy]);
            const before = (await pool.query('SELECT * FROM opencode_model_sync_settings')).rows;
            expect(await service.context(device)).toMatchObject({ revision: 3, transferCredentials: false });
            expect(await service.read(request, device.id)).toMatchObject({ transferCredentials: false, canTransferCredentials: false, legacyTransferCredentials: legacy });
            const write = vi.spyOn(service.repository, 'sync'), read = vi.spyOn(service.repository, 'settings'); const scan = snapshot();
            await expect(sync(scan, { [scan.candidates[0]!.candidateId]: secret }, 3)).rejects.toMatchObject({ status: 403 });
            expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); write.mockRestore(); read.mockRestore();
            expect(await cards()).toHaveLength(0); expect((await pool.query('SELECT * FROM model_remote_connections')).rows).toHaveLength(0);
            expect((await pool.query('SELECT * FROM opencode_model_snapshots')).rows).toHaveLength(0); expect((await pool.query('SELECT * FROM security_events')).rows).toHaveLength(0);
            expect((await pool.query('SELECT * FROM opencode_model_sync_settings')).rows).toEqual(before);
        }
        await expect(service.configure(request, device.id, { expectedRevision: 3, enabled: true, transferCredentials: false })).rejects.toMatchObject({ status: 409 });
    });
    it('metadata settings and reload preserve the previous encrypted history and stored preference', async () => {
        await sync(snapshot()); const model = (await cards())[0], head = (await remote.head(model.id))!;
        await pool.query("UPDATE model_remote_connections SET credential_kind='stored',credential=$3 WHERE model_id=$1 AND revision=$2", [model.id, head.revision, sealModelCredential(secret, model.id, Number(head.revision))]);
        await pool.query('INSERT INTO opencode_model_sync_settings(device_id,revision,enabled,transfer_credentials) VALUES($1,1,true,true)', [device.id]);
        const previous = (await pool.query('SELECT * FROM model_remote_connections')).rows;
        expect(await service.configure(request, device.id, { expectedRevision: 1, enabled: false })).toMatchObject({ revision: 2, enabled: false, transferCredentials: false, legacyTransferCredentials: true });
        expect(await service.configure(request, device.id, { expectedRevision: 2, enabled: true })).toMatchObject({ revision: 3, enabled: true, transferCredentials: false, legacyTransferCredentials: true });
        await expect(sync(snapshot(), {}, 2)).rejects.toThrow('Настройки'); await sync(snapshot(), {}, 3);
        expect((await pool.query('SELECT * FROM model_remote_connections')).rows).toEqual(previous);
        expect((await service.repository.settings(device.id)).transferCredentials).toBe(true);
        expect(JSON.stringify(await service.read(request, device.id))).not.toContain(secret);
        await expect(service.configure(request, device.id, { expectedRevision: 2, enabled: true })).rejects.toThrow('другом окне');
    });
    it('manual connection edits and credentials from another computer always win over automatic updates', async () => {
        await sync(snapshot()); const model = (await cards())[0];
        await remote.save(model.id, { expectedModelRevision: 1, expectedRevision: 1, baseUrl: 'https://manual.example.test/v1', requestDimensions: false, credential: 'stored', apiKey: secret, options: { contextWindow: 8192 } }, device.email, async () => undefined);
        const previous = await remote.head(model.id); await sync(snapshot());
        expect(await remote.head(model.id)).toEqual(previous);
        expect((await service.repository.sources(device.id))[0].credentialStatus).toBe('manual');
    });
    it('aliases and other computers cannot take ownership of the original source connection', async () => {
        await sync(snapshot()); const model = (await cards())[0], before = await remote.head(model.id);
        await sync(snapshot([candidate(), candidate({ configKey: 'other-alias' })]));
        expect(await remote.head(model.id)).toEqual(before); expect(await cards()).toHaveLength(1);
        const other = { ...device, id: randomUUID() };
        await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) SELECT $2,email,role,name,fingerprint,$3,report FROM bridge_devices WHERE id=$1', [device.id, other.id, randomBytes(32).toString('hex')]);
        await service.configure(request, other.id, { expectedRevision: 0, enabled: true });
        const scan = snapshot(); await service.sync(other, { scan, settingsRevision: 1, credentials: {} }, async () => other);
        expect(await remote.head(model.id)).toEqual(before); expect((await service.repository.sources(other.id))[0].credentialStatus).toBe('manual');
    });
    it('duplicate source aliases and role revocation before commit roll back all cards and keys', async () => {
        await expect(sync(snapshot([candidate(), candidate()]))).rejects.toThrow('повторяющиеся');
        let calls = 0; const scan = snapshot();
        await expect(service.sync(device, { scan, settingsRevision: 0, credentials: {} }, async () => ++calls === 1 ? device : { ...device, role: 'Разработчик' })).rejects.toBeInstanceOf(ForbiddenException);
        expect(await cards()).toHaveLength(0); expect((await pool.query('SELECT * FROM model_remote_connections')).rows).toHaveLength(0);
    });
    it('manual metadata edits and archived cards are never silently restored or renamed', async () => {
        await sync(snapshot()); let model = (await cards())[0];
        await modelRepo.update(model.id, { expectedRevision: model.revision, name: 'My edited model' }, device.email);
        await sync(snapshot()); expect(Number((await remote.head(model.id))!.revision)).toBe(1);
        model = (await cards())[0]; await modelRepo.unassign(project, model.id, device.email); await modelRepo.remove(model.id, { expectedRevision: model.revision }, device.email);
        await sync(snapshot()); expect((await cards())[0].archived_at).toBeTruthy(); expect(await cards()).toHaveLength(1);
    });
    it('first discovery assigns the bound project but later scans respect explicit removal from that project', async () => {
        await sync(snapshot()); const model = (await cards())[0]; expect(await modelRepo.isAssigned(project, model.id)).toBe(true);
        await modelRepo.unassign(project, model.id, device.email); await sync(snapshot());
        expect(await modelRepo.isAssigned(project, model.id)).toBe(false); expect((await service.repository.sources(device.id))[0].assigned).toBe(false);
    });
    it('explicit administrator revocation is never undone by the next automatic snapshot', async () => {
        await sync(snapshot()); const model = (await cards())[0];
        await remote.revoke(model.id, model.revision, 1, device.email, async () => undefined);
        const revoked = await remote.head(model.id); expect(revoked!.revoked_at).toBeTruthy();
        await sync(snapshot()); expect(await remote.head(model.id)).toEqual(revoked);
        expect((await service.repository.sources(device.id))[0].credentialStatus).toBe('manual');
    });
    it('invalid/incomplete scans preserve sources; valid disable/removal only update lineage', async () => {
        await sync(snapshot()); const model = (await cards())[0], connection = await remote.head(model.id);
        expect((await sync(snapshot([], ['invalid-json']))).incomplete).toBe(true); expect((await service.repository.sources(device.id))[0].state).toBe('present');
        await sync(snapshot([candidate({ blocker: 'disabled-provider' })])); expect((await service.repository.sources(device.id))[0].state).toBe('disabled');
        await sync(snapshot([])); expect((await service.repository.sources(device.id))[0].state).toBe('missing');
        expect(await remote.head(model.id)).toEqual(connection); expect((await cards())[0].archived_at).toBeNull();
    });
    it('a valid empty first snapshot prevents an older delayed nonempty snapshot from resurrecting models', async () => {
        const older = snapshot(); older.checkedAt = new Date(Date.now() - 10000).toISOString(); older.expiresAt = new Date(Date.now() + 890000).toISOString(); older.digest = modelScanDigest(older);
        const current = snapshot([]); await sync(current);
        const before = (await pool.query('SELECT * FROM opencode_model_snapshots')).rows;
        const sources = (await pool.query('SELECT * FROM opencode_model_sources')).rows;
        expect(before).toHaveLength(1); expect(before[0].scan_digest).toBe(current.digest);
        await expect(sync(older)).rejects.toMatchObject({ status: 409 });
        expect(await cards()).toHaveLength(0);
        expect((await pool.query('SELECT * FROM model_remote_connections')).rows).toHaveLength(0);
        expect((await pool.query('SELECT * FROM model_catalog_versions')).rows).toHaveLength(0);
        expect((await pool.query('SELECT * FROM project_models')).rows).toHaveLength(0);
        expect((await pool.query('SELECT * FROM bridge_jobs')).rows).toHaveLength(0);
        expect((await pool.query('SELECT * FROM opencode_model_sources')).rows).toEqual(sources);
        expect((await pool.query('SELECT * FROM opencode_model_snapshots')).rows).toEqual(before);
    });
    it('concurrent discovery is idempotent and semantic option changes create a new immutable connection identity', async () => {
        await Promise.all([sync(snapshot()), sync(snapshot())]); const model = (await cards())[0]; expect(await cards()).toHaveLength(1);
        await sync(snapshot([candidate({ capability: 'vision', options: { contextWindow: 32768 } })]));
        expect(Number((await remote.head(model.id))!.revision)).toBe(1); expect(await cards()).toHaveLength(2);
        const source=(await service.repository.sources(device.id))[0];expect(source.modelId).not.toBe(model.id);expect((await pool.query('SELECT descriptor FROM model_catalog WHERE id=$1',[source.modelId])).rows[0].descriptor.capability).toBe('vision');
    });
    it('foreign owner, wrong binding, expired/future metadata, malformed keys and removed roles fail closed', async () => {
        await expect(service.read(request, randomUUID())).rejects.toBeInstanceOf(ForbiddenException);
        const wrong = snapshot(); wrong.bindingId = 'f'.repeat(64); wrong.digest = modelScanDigest(wrong); await expect(sync(wrong)).rejects.toThrow('снимок');
        const future = snapshot(); future.checkedAt = new Date(Date.now() + 120000).toISOString(); future.expiresAt = new Date(Date.now() + 1020000).toISOString(); future.digest = modelScanDigest(future); await expect(sync(future)).rejects.toThrow('снимок');
        const malformed = snapshot(); (malformed.candidates[0] as unknown as { apiKey: string }).apiKey = secret; malformed.digest = modelScanDigest(malformed); await expect(sync(malformed)).rejects.toThrow('снимок');
        roleAllowed = false; await expect(sync(snapshot())).rejects.toBeInstanceOf(ForbiddenException); expect(await cards()).toHaveLength(0);
    });
    it('context skips invalid folders without hiding valid ones; physical schema drift is detected', async () => {
        device.report.bindings = [...device.report.bindings as unknown[], { projectId: 'prj-invalid', folderName: 'invalid', valid: false }];
        expect((await service.context(device)).bindings).toHaveLength(1); await assertOpenCodeModelSyncSchema(pool);
        await pool.query('ALTER TABLE opencode_model_sync_settings ALTER COLUMN transfer_credentials DROP DEFAULT');
        await expect(assertOpenCodeModelSyncSchema(pool)).rejects.toThrow('transfer_credentials');
        await pool.query('ALTER TABLE opencode_model_sync_settings ALTER COLUMN transfer_credentials SET DEFAULT false');
    });
});
