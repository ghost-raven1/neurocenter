import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { startSkillPackagingFixture } from './skill-packaging.fixture.mjs';
const { modelScanDigest } = createRequire(import.meta.url)('../../services/shared/opencode-model-scan.cjs');
const adminUrl = process.env.OPENCODE_MODEL_SYNC_TEST_PG_URL;

test('Automatic OpenCode model import crosses the real Gateway without exposing keys', {
    skip: !adminUrl ? 'Set OPENCODE_MODEL_SYNC_TEST_PG_URL to an owned isolated PostgreSQL port.' : false, timeout: 120000,
}, async t => {
    const f = await startSkillPackagingFixture({ adminUrl }); t.after(() => f.close());
    const deviceId = randomUUID(), token = randomBytes(32).toString('hex'), bindingId = 'a'.repeat(64), instanceId = randomUUID(), secret = 'qa-api-key-' + randomUUID();
    const report = { protocolVersion: 2, capabilities: ['durable-completions','managed-installations','workspace-instance-v1','opencode-model-scan-v2','opencode-model-sync-v2'], bindings: [{ projectId: f.projectId, folderName: 'qa', bindingId, instanceId }] };
    await f.pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,'Главный админ','OpenCode sync QA',$3,$4,$5::jsonb)", [deviceId, f.actors.main.email, 'b'.repeat(64), createHash('sha256').update(token).digest('hex'), JSON.stringify(report)]);
    const settingsPath = '/api/devices/' + deviceId + '/opencode-model-sync';
    const snapshot = (patch = {}) => {
        const now = new Date(), candidateId = randomUUID();
        const scan = { schemaVersion: 2, scope: 'project', projectId: f.projectId, bindingId, instanceId, scanId: randomUUID(), checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString(), warnings: [], candidates: [{ candidateId, configKey: 'alias', provider: 'team', name: 'OpenCode synced model', model: 'upstream-chat', modelVersion: 'upstream-chat', capability: 'chat', runtime: 'remote-openai', baseUrl: 'https://provider.example.test/v1', hasKey: true, credentialSource: 'environment', blocker: null, options: { contextWindow: 128000, temperature: 0 }, outputTokenLimit: 64000 }], digest: '', ...patch };
        scan.digest = modelScanDigest(scan); return scan;
    };
    const channel = (suffix, body, status = 201, headers = {}) => f.request(null, '/api/device-channel/opencode-models/' + suffix, { method: 'POST', body, status, headers: { authorization: 'Bearer ' + token, ...headers } });
    const globalSnapshot=(modelId)=>{
        const {projectId:_project,bindingId:_binding,instanceId:_instance,...metadata}=snapshot();
        const scan={...metadata,scope:'global',deviceId,candidates:metadata.candidates.map(candidate=>({...candidate,model:modelId,modelVersion:modelId,name:modelId,hasKey:false,credentialSource:'none'}))};scan.digest=modelScanDigest(scan);return scan;
    };
    let model;
    await t.test('Only the owner with the main-admin role controls auto-import and credential consent', async () => {
        await f.request(null, settingsPath, { status: 401 }); await f.request('developer', settingsPath, { status: 403 });
        const settings = await f.request('main', settingsPath); assert.equal(settings.enabled, true); assert.equal(settings.transferCredentials, false);
        const context = await channel('context', {}); assert.equal(context.transferCredentials, false); assert.equal(context.bindings[0].projectId, f.projectId);
    });
    await t.test('Discovery creates one catalogue card and an unverified connection with exact model context', async () => {
        await channel('sync', { settingsRevision: 0, scan: snapshot(), credentials: {} });
        const catalogue = await f.request('main', '/api/models'); model = catalogue.items.find(item => item.model === 'upstream-chat'); assert.ok(model);
        assert.ok((await f.request('main','/api/models?projectId='+encodeURIComponent(f.projectId))).assignedModelIds.includes(model.id));
        const connection = await f.request('main', '/api/models/' + model.id + '/connection'); assert.equal(connection.hasKey, false); assert.equal(connection.options.contextWindow, 128000); assert.equal(connection.options.maxOutputTokens, undefined);
        await channel('sync', { settingsRevision: 0, scan: snapshot(), credentials: {} });
        assert.equal((await f.request('main', '/api/models')).items.filter(item => item.model === 'upstream-chat').length, 1);
    });
    await t.test('HTTPS is mandatory for keys, an untrusted forwarded header cannot bypass it, and consent remains separate', async () => {
        let scan = snapshot(), body = { settingsRevision: 0, scan, credentials: { [scan.candidates[0].candidateId]: secret } };
        await channel('sync', body, 403, { 'x-forwarded-proto': 'https' });
        process.env.NEUROCENTER_TLS_PROXY_ADDRESSES = '127.0.0.1';
        await channel('sync', body, 403, { 'x-forwarded-proto': 'https' });
        const settings = await f.request('main', settingsPath, { method: 'PUT', body: { expectedRevision: 0, enabled: true, transferCredentials: true } }); assert.equal(settings.revision, 1);
        scan = snapshot(); body = { settingsRevision: 1, scan, credentials: { [scan.candidates[0].candidateId]: secret } };
        await channel('sync', body, 201, { 'x-forwarded-proto': 'https' });
        const connection = await f.request('main', '/api/models/' + model.id + '/connection'); assert.equal(connection.hasKey, true); assert.equal(JSON.stringify(connection).includes(secret), false);
        const stored = (await f.pool.query('SELECT * FROM model_remote_connections WHERE model_id=$1 ORDER BY revision DESC LIMIT 1', [model.id])).rows[0]; assert.equal(stored.credential.algorithm, 'A256GCM'); assert.equal(JSON.stringify(stored).includes(secret), false);
        for (const route of [settingsPath, '/api/devices', '/api/models', '/api/device-jobs']) assert.equal(JSON.stringify(await f.request('main', route)).includes(secret), false, route);
        assert.equal(JSON.stringify((await f.pool.query('SELECT * FROM security_events')).rows).includes(secret), false);
    });
    await t.test('Consent withdrawal rejects delayed snapshots and malformed metadata cannot enter source lineage', async () => {
        await f.request('main', settingsPath, { method: 'PUT', body: { expectedRevision: 1, enabled: true, transferCredentials: false } });
        await channel('sync', { settingsRevision: 1, scan: snapshot(), credentials: {} }, 409);
        const scan = snapshot(); scan.candidates[0].apiKey = secret; scan.digest = modelScanDigest(scan);
        await channel('sync', { settingsRevision: 2, scan, credentials: {} }, 409);
        assert.equal(JSON.stringify(await f.request('main', settingsPath)).includes(secret), false);
        assert.deepEqual(f.state.externalCalls, []);
    });
    await t.test('Global automatic discovery needs no bound folder, preserves source identity and assigns no project',async()=>{
        report.bindings=[];await f.pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[deviceId,JSON.stringify(report)]);
        const context=await channel('context',{});assert.equal(context.schemaVersion,2);assert.deepEqual(context.global,{deviceId});assert.deepEqual(context.bindings,[]);
        const scan=globalSnapshot('global-only-chat');await channel('sync',{settingsRevision:2,scan,credentials:{}});
        const source=(await f.request('main',settingsPath)).sources.find(item=>item.scope==='global');assert.equal(source.projectId,null);assert.equal(source.assigned,false);
        assert.equal((await f.pool.query('SELECT 1 FROM project_models WHERE model_id=$1',[source.modelId])).rowCount,0);
        const wrong={...scan,deviceId:randomUUID()};wrong.digest=modelScanDigest(wrong);await channel('sync',{settingsRevision:2,scan:wrong,credentials:{}},409);
        const old={...scan,schemaVersion:1};old.digest=modelScanDigest(old);await channel('sync',{settingsRevision:2,scan:old,credentials:{}},409);
    });
    await t.test('Manual global read/claim/completion/import crosses Gateway with no fictitious project',async()=>{
        const input={kind:'scan-opencode-models',scope:'global',deviceId,requestKey:randomUUID()};
        await f.request('developer','/api/device-jobs',{method:'POST',body:input,status:403});
        await f.request('main','/api/device-jobs',{method:'POST',body:{...input,requestKey:randomUUID(),projectId:f.projectId},status:400});
        const job=await f.request('main','/api/device-jobs',{method:'POST',body:input,status:201});assert.equal(job.projectId,null);
        const claimed=await f.request(null,'/api/device-channel/jobs/claim',{method:'POST',body:{},status:201,headers:{authorization:'Bearer '+token}});assert.equal(claimed.id,job.id);assert.equal(claimed.project_id,null);assert.deepEqual(claimed.payload,{scope:'global',deviceId});
        await f.request(null,'/api/device-channel/jobs/'+job.id+'/authorize',{method:'POST',status:201,headers:{authorization:'Bearer '+token},body:{lease:claimed.lease}});
        const scan=globalSnapshot('manual-global-chat');scan.candidates.push({...scan.candidates[0],candidateId:randomUUID(),configKey:'second-alias',options:{contextWindow:32000,temperature:0.7}});scan.digest=modelScanDigest(scan);
        await f.request(null,'/api/device-channel/jobs/'+job.id+'/complete',{method:'POST',status:201,headers:{authorization:'Bearer '+token},body:{lease:claimed.lease,state:'succeeded',message:'Metadata ready',result:scan}});
        const body={deviceId,jobId:job.id,candidateId:scan.candidates[0].candidateId};
        const imported=await f.request('main','/api/models/import-opencode',{method:'POST',status:201,body});assert.equal(imported.model.model,'manual-global-chat');assert.equal(imported.options.contextWindow,128000);
        const again=await f.request('main','/api/models/import-opencode',{method:'POST',status:201,body});assert.equal(again.model.id,imported.model.id);assert.equal(again.repeated,true);
        const variant=await f.request('main','/api/models/import-opencode',{method:'POST',status:201,body:{...body,candidateId:scan.candidates[1].candidateId}});assert.notEqual(variant.model.id,imported.model.id);assert.notEqual(variant.model.name,imported.model.name);assert.equal(variant.options.contextWindow,32000);
        assert.equal((await f.pool.query('SELECT 1 FROM project_models WHERE model_id=$1',[imported.model.id])).rowCount,0);assert.deepEqual(f.state.externalCalls,[]);
    });
    await t.test('Feature withdrawal blocks fresh, queued and running scans while consent withdrawal and failed ACK remain available',async()=>{
        const newJob=()=>f.request('main','/api/device-jobs',{method:'POST',status:201,body:{kind:'scan-opencode-models',scope:'global',deviceId,requestKey:randomUUID()}});
        const claim=()=>f.request(null,'/api/device-channel/jobs/claim',{method:'POST',body:{},status:201,headers:{authorization:'Bearer '+token}});
        const queued=await newJob();f.state.featureOverrides.opencode_model_sync=false;
        await channel('context',{},403);await channel('sync',{settingsRevision:2,scan:globalSnapshot('must-not-import'),credentials:{}},403);
        await f.request('main','/api/device-jobs',{method:'POST',status:403,body:{kind:'scan-opencode-models',scope:'global',deviceId,requestKey:randomUUID()}});
        assert.equal(await claim(),null);const rejected=(await f.pool.query('SELECT state,message FROM bridge_jobs WHERE id=$1',[queued.id])).rows[0];assert.equal(rejected.state,'failed');assert.match(rejected.message,/отключена/);
        assert.equal((await f.request('main','/api/models')).items.some(item=>item.model==='must-not-import'),false);
        f.state.featureOverrides.opencode_model_sync=true;const running=await newJob(),leased=await claim();assert.equal(leased.id,running.id);f.state.featureOverrides.opencode_model_sync=false;
        await f.request(null,'/api/device-channel/jobs/'+running.id+'/authorize',{method:'POST',status:403,headers:{authorization:'Bearer '+token},body:{lease:leased.lease}});
        await f.request(null,'/api/device-channel/jobs/'+running.id+'/complete',{method:'POST',status:201,headers:{authorization:'Bearer '+token},body:{lease:leased.lease,state:'failed',message:'Disabled',result:{}}});
        const settings=await f.request('main',settingsPath,{method:'PUT',body:{expectedRevision:2,enabled:false,transferCredentials:false}});assert.equal(settings.enabled,false);
        await f.request('main',settingsPath,{method:'PUT',status:403,body:{expectedRevision:3,enabled:true,transferCredentials:false}});
        assert.deepEqual(f.state.externalCalls,[]);delete f.state.featureOverrides.opencode_model_sync;
    });
    await t.test('Revoked computers cannot keep discovering or transmitting models', async () => {
        await f.request('main', '/api/devices/' + deviceId, { method: 'DELETE' }); await channel('context', {}, 401);
        await channel('sync', { settingsRevision: 2, scan: snapshot(), credentials: {} }, 401);
    });
});
