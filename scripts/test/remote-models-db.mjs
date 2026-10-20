import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Только собственная БД и локальный HTTP provider: реальные ключи и модели не используются.
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const ts=require('typescript');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,filename);
const {Pool}=require('pg');
const {setupModelsSchema,ModelsRepository}=require(path.join(root,'services/catalog-service/src/models/models.repository.ts'));
const {setupSecurityEvents}=require(path.join(root,'services/catalog-service/src/access/security-events.ts'));
const {RemoteConnectionService}=require(path.join(root,'services/catalog-service/src/models/remote-connection.service.ts'));
const {RemoteConnectionRepository}=require(path.join(root,'services/catalog-service/src/models/remote-connection.repository.ts'));
const {projectEmbeddingPin}=require(path.join(root,'services/catalog-service/src/models/project-embedding.validation.ts'));
const {remoteVerificationDigest}=require(path.join(root,'services/catalog-service/src/models/remote-model-validation.ts'));
const {readPinnedModel,saveModelVersion,nextModelRevision}=require(path.join(root,'services/catalog-service/src/models/model-history.ts'));
const {OllamaClient}=require(path.join(root,'services/catalog-service/src/models/ollama-client.ts'));
const {localModelAlias}=require(path.join(root,'services/catalog-service/src/models/local-model-alias.ts'));
const {archiveModelWithClient}=require(path.join(root,'services/catalog-service/src/models/model-archive.ts'));
const {ModelBundleRuntime}=require(path.join(root,'services/catalog-service/src/models/model-bundle-runtime.ts'));
const {OpenCodeModelImport}=require(path.join(root,'services/catalog-service/src/models/opencode-model-import.ts'));
const {modelScanDigest}=require(path.join(root,'services/shared/opencode-model-scan.cjs'));
const {ModelRuntime}=require(path.join(root,'services/catalog-service/src/models/model-runtime.ts'));
const adminUrl=process.env.REMOTE_MODEL_TEST_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin=new Pool({connectionString:adminUrl,max:2});
const database='nc_remote_models_test_'+randomBytes(8).toString('hex');
const before=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate')).rows.map(row=>row.datname);
const originalKey=process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY;
process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY=randomBytes(32).toString('base64');
const secret='fixture-secret-'+randomBytes(16).toString('hex');
let pool,server,created=false,removed=false,fatal,temporary;const originalStorage=process.env.MODEL_STORAGE_PATH;
let mode='valid',requests=0,lastBody,lastAuthorization,hold;
const checks=[];
const check=async(name,action)=>{try{await action();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});throw error;}};
try {
    await admin.query('CREATE DATABASE "'+database+'"');created=true;
    const url=new URL(adminUrl);url.pathname='/'+database;pool=new Pool({connectionString:url.href,max:5});
    await pool.query('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE project_embedding_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id),model_id TEXT)');
    await setupSecurityEvents(pool);await setupModelsSchema(pool);
    const models=new ModelsRepository(pool);
    const service=new RemoteConnectionService({pool,get:id=>models.get(id)});
    const privateRepo=service.repository;
    let card=await models.create({name:'Remote fixture',runtime:'remote-openai',capability:'embedding',model:'fixture-model',modelVersion:'v1',dimension:3},'qa');
    server=createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);lastBody=JSON.parse(Buffer.concat(chunks));lastAuthorization=req.headers.authorization;requests++;
        if(hold)await hold;
        res.writeHead(mode==='auth'?401:200,{'content-type':'application/json'});
        if(mode==='auth'){res.end(JSON.stringify({error:secret}));return;}
        res.end(JSON.stringify({object:'list',model:lastBody.model,data:lastBody.input.map((_text,index)=>({object:'embedding',index,embedding:mode==='dimension'?[1,2]:[1,index+1,3]})),usage:{prompt_tokens:2}}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+server.address().port+'/v1';
    const input=(patch={})=>({expectedRevision:0,expectedModelRevision:card.revision,baseUrl:endpoint,requestDimensions:true,credential:'stored',apiKey:secret,...patch});
    let view;
    await check('Write-only key, encrypted DB, audit and native descriptor do not disclose provider connection',async()=>{
        view=await service.save(card.id,input(),'qa',async()=>{});card=await models.get(card.id);
        assert.equal(view.hasKey,true);assert.equal(view.verified,false);assert.equal(view.canStoreKey,true);
        assert.equal('apiKey'in view,false);assert.equal('credential'in card,false);assert.equal('baseUrl'in card,false);
        const row=await privateRepo.head(card.id);assert.equal(row.credential.algorithm,'A256GCM');assert.equal(JSON.stringify(row).includes(secret),false);
        const audit=(await pool.query('SELECT before_state,after_state FROM security_events')).rows;
        assert.equal(JSON.stringify(audit).includes(secret),false);assert.equal(JSON.stringify(audit).includes(endpoint),false);
    });
    await check('Probe pins actual dimensions and the unified remote dispatcher has no local fallback',async()=>{
        await service.check(card,'qa',async()=>{});card=await models.get(card.id);
        assert.match(card.verificationSha256,/^[a-f0-9]{64}$/);assert.equal(card.manifestSha256,null);assert.equal(card.dimension,3);
        const runtime=new ModelRuntime({infer:()=>{throw Error('Unexpected local fallback');}},service);
        const result=await runtime.infer(card,'embed',{input:['fixture']});assert.deepEqual(result.embeddings,[[1,1,3]]);
        assert.equal(lastAuthorization,'Bearer '+secret);assert.equal(lastBody.dimensions,3);assert.equal((await service.status(card)).state,'ready');
    });
    const original=card,originalPin=projectEmbeddingPin(original);
    await check('Reverification appends immutable checked connection semantics and reseals the stored key for its new AAD',async()=>{
        let head=await models.create({name:'Immutable checked connection',runtime:'remote-openai',capability:'embedding',model:'immutable-fixture',modelVersion:'v1',dimension:3},'qa');
        await service.save(head.id,input({expectedRevision:0,expectedModelRevision:head.revision}),'qa',async()=>{});
        head=await models.get(head.id);await service.check(head,'qa',async()=>{});head=await models.get(head.id);
        const pinned=head,pin=projectEmbeddingPin(head),first=await privateRepo.head(head.id);
        assert.equal(Number(first.revision),1);assert.ok(first.semantic_sha);
        head=await models.update(head.id,{expectedRevision:head.revision,description:'Metadata keeps the checked semantic pin'},'qa');
        assert.equal(projectEmbeddingPin(head),pin);assert.equal((await service.infer(pinned,'embed',{input:['metadata continuity']})).embeddings[0].length,3);
        head=await models.update(head.id,{expectedRevision:head.revision,modelVersion:'v2'},'qa');
        assert.equal(head.verificationSha256,null);assert.equal((await service.infer(pinned,'embed',{input:['unverified head continuity']})).embeddings[0].length,3);
        const digest=remoteVerificationDigest(head,privateRepo.connection(first),3),beforeRevision=head.revision;
        await assert.rejects(service.check(head,'qa',async()=>{throw Error('Append authorization withdrawn');}),/authorization withdrawn/);
        const wrongKey=new RemoteConnectionRepository(pool,{NEUROCENTER_MODEL_CREDENTIAL_KEY:randomBytes(32).toString('base64')});
        await assert.rejects(wrongKey.verify(head,1,digest,3,'qa',async()=>{}),/Не удалось открыть ключ/);
        await pool.query(`CREATE FUNCTION fixture_checked_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='${head.id}' AND NEW.action='model.connection.verify' THEN RAISE EXCEPTION 'fixture checked audit failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fixture_checked_audit_failure BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fixture_checked_audit_failure()`);
        try{await assert.rejects(service.check(head,'qa',async()=>{}),/fixture checked audit failure/);}
        finally{await pool.query('DROP TRIGGER fixture_checked_audit_failure ON security_events;DROP FUNCTION fixture_checked_audit_failure()');}
        assert.equal((await models.get(head.id)).revision,beforeRevision);
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM model_remote_connections WHERE model_id=$1',[head.id])).rows[0].count,1);
        assert.equal((await privateRepo.head(head.id)).semantic_sha,first.semantic_sha);
        await service.check(head,'qa',async()=>{});head=await models.get(head.id);
        const retained=(await pool.query('SELECT * FROM model_remote_connections WHERE model_id=$1 AND revision=1',[head.id])).rows[0];
        assert.equal(retained.semantic_sha,first.semantic_sha);assert.deepEqual(retained.credential,first.credential);
        const second=await privateRepo.head(head.id);assert.equal(Number(second.revision),2);assert.notEqual(second.semantic_sha,first.semantic_sha);
        assert.notDeepEqual(second.credential,first.credential);assert.equal(privateRepo.connection(second).apiKey,secret);
        assert.throws(()=>privateRepo.connection({...second,revision:1}),/Не удалось открыть ключ/);
        assert.equal((await service.infer(await readPinnedModel(pool,head.id,pin),'embed',{input:['verified new head continuity']})).embeddings[0].length,3);
        assert.equal((await service.infer(head,'embed',{input:['new head']})).embeddings[0].length,3);
        const revision=head.revision;await service.check(head,'qa',async()=>{});head=await models.get(head.id);
        assert.equal(Number((await privateRepo.head(head.id)).revision),2);assert.equal(head.revision,revision);
        await assert.rejects(privateRepo.verify(head,1,second.semantic_sha,3,'qa',async()=>{}),/изменились/);
        const audit=(await pool.query("SELECT after_state FROM security_events WHERE resource_id=$1 AND action='model.connection.verify' ORDER BY created_at DESC LIMIT 1",[head.id])).rows[0];
        assert.equal(audit.after_state.connectionRevision,2);assert.equal(JSON.stringify(audit).includes(secret),false);
        await models.remove(head.id,{expectedRevision:head.revision},'qa');
    });
    await check('Changed checked semantics copy environment and anonymous credentials without secret fields',async()=>{
        const name='NEUROCENTER_REMOTE_MODEL_QA_TEST',previous=process.env[name],master=process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY;process.env[name]=secret;delete process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY;
        try{for(const credential of ['environment','none']){
            let head=await models.create({name:'Immutable '+credential,runtime:'remote-openai',capability:'embedding',model:'fixture-'+credential,modelVersion:'v1',dimension:3},'qa');
            await service.save(head.id,{expectedRevision:0,expectedModelRevision:head.revision,baseUrl:endpoint,requestDimensions:true,credential,...credential==='environment'?{credentialEnv:name}:{}},'qa',async()=>{});
            head=await models.get(head.id);await service.check(head,'qa',async()=>{});head=await models.get(head.id);const pinned=head;
            head=await models.update(head.id,{expectedRevision:head.revision,modelVersion:'v2'},'qa');await service.check(head,'qa',async()=>{});
            const second=await privateRepo.head(head.id);assert.equal(Number(second.revision),2);assert.equal(second.credential,null);
            assert.equal(second.credential_env,credential==='environment'?name:null);assert.equal(second.credential_kind,credential);
            assert.equal((await service.infer(pinned,'embed',{input:['old checked environment/none pin']})).embeddings[0].length,3);
            assert.equal(JSON.stringify(await service.read(head.id)).includes(secret),false);
            head=await models.get(head.id);await models.remove(head.id,{expectedRevision:head.revision},'qa');
        }}finally{if(previous===undefined)delete process.env[name];else process.env[name]=previous;if(master===undefined)delete process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY;else process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY=master;}
    });
    await check('Concurrent config writes are CAS-protected; obsolete callers do not overwrite keys',async()=>{
        const a=input({expectedRevision:view.revision,expectedModelRevision:card.revision});
        const results=await Promise.allSettled([service.save(card.id,a,'qa',async()=>{}),service.save(card.id,a,'qa',async()=>{})]);
        assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);
        card=await models.get(card.id);view=await service.read(card.id);
        assert.equal(card.verificationSha256,null);
    });
    await check('Catalog head changes preserve historical pin and verified connection while a replacement is unverified',async()=>{
        const pinned=await readPinnedModel(pool,card.id,originalPin);assert.equal(pinned.verificationSha256,original.verificationSha256);
        const result=await service.infer(pinned,'embed',{input:['old index']});assert.equal(result.embeddings[0].length,3);
        const previous=card.revision;
        card=await models.update(card.id,{expectedRevision:previous,model:'fixture-next',modelVersion:'v2'},'qa');
        assert.equal(card.verificationSha256,null);assert.equal((await readPinnedModel(pool,card.id,originalPin)).model,'fixture-model');
    });
    await check('Owner withdrawal and concurrent edits during a real probe cannot commit a verified pin',async()=>{
        const before=card.revision;
        await assert.rejects(service.check(card,'qa',async()=>{throw Error('Role revoked');}),/Role revoked/);
        assert.equal((await models.get(card.id)).revision,before);
        let release;hold=new Promise(resolve=>{release=resolve;});const start=requests;
        const pending=service.check(card,'qa',async()=>{});
        while(requests===start)await new Promise(resolve=>setTimeout(resolve,5));
        await models.update(card.id,{expectedRevision:card.revision,description:'Concurrent metadata'},'qa');
        release();hold=null;await assert.rejects(pending,/изменились/);card=await models.get(card.id);assert.equal(card.verificationSha256,null);
    });
    await check('Dimension mismatch and provider authorization failure preserve the previous valid snapshot',async()=>{
        for(const variant of ['dimension','auth']){mode=variant;await assert.rejects(service.check(card,'qa',async()=>{}));assert.equal((await models.get(card.id)).verificationSha256,null);}
        mode='valid';await service.check(card,'qa',async()=>{});card=await models.get(card.id);
        assert.notEqual(card.verificationSha256,original.verificationSha256);
    });
    await check('Connection removal blocks active RAG projects and catalog-only archive preserves old inference',async()=>{
        await pool.query("INSERT INTO projects VALUES('prj-fixture','Protected project')");await pool.query("INSERT INTO project_embedding_settings VALUES('prj-fixture',$1)",[card.id]);
        await models.assign('prj-fixture',card.id,'qa');
        await assert.rejects(models.unassign('prj-fixture',card.id,'qa'),/текущим индексом/);
        assert.equal(await models.isAssigned('prj-fixture',card.id),true);
        view=await service.read(card.id);
        await assert.rejects(service.revoke(card.id,{expectedRevision:view.revision,expectedModelRevision:card.revision},'qa',async()=>{}),error=>error.getResponse().projects[0].id==='prj-fixture');
        await assert.rejects(models.remove(card.id,{expectedRevision:card.revision},'qa'),/используется в проектах/);
        const client=await pool.connect();
        try {
            await client.query('BEGIN');
            await assert.rejects(archiveModelWithClient(client,card.id,card.revision,'qa',{removeProjectRefs:true}),error=>error.getResponse().projects[0].id==='prj-fixture');
            await client.query('ROLLBACK');await client.query('BEGIN');
            await archiveModelWithClient(client,card.id,card.revision,'qa');await client.query('COMMIT');
        } finally {client.release();}
        const archived=await models.get(card.id);assert.ok(archived.archivedAt);assert.equal((await models.list()).length,0);
        assert.equal((await service.infer(original,'embed',{input:['historical']})).embeddings[0].length,3);
        assert.equal((await readPinnedModel(pool,card.id,originalPin)).archivedAt,archived.archivedAt);
        card=archived;
    });
    await check('Explicit credential revoke blocks every historical revision without exposing keys',async()=>{
        await pool.query('DELETE FROM project_embedding_settings');
        await service.revoke(card.id,{expectedRevision:view.revision,expectedModelRevision:card.revision},'qa',async()=>{});
        await assert.rejects(service.infer(original,'embed',{input:['revoked']}),/отозвано/);
        const after=await service.read(card.id);assert.equal(after.hasKey,false);assert.equal(after.baseUrl,'');
        const wrong=new RemoteConnectionRepository(pool,{NEUROCENTER_MODEL_CREDENTIAL_KEY:randomBytes(32).toString('base64')});
        const row=await privateRepo.head(card.id);assert.throws(()=>wrong.connection({...row,revoked_at:null}),/Не удалось открыть ключ/);
    });
    await check('OpenCode import validates owner, exact device/binding/instance, expiry and idempotence without copying keys',async()=>{
        const deviceId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',candidateId='33333333-3333-4333-8333-333333333333',instanceId='44444444-4444-4444-8444-444444444444',bindingId='a'.repeat(64);
        await pool.query("CREATE TABLE bridge_devices(id TEXT PRIMARY KEY,email TEXT,report JSONB,revoked BOOLEAN,expires_at TIMESTAMPTZ); CREATE TABLE bridge_jobs(id TEXT PRIMARY KEY,device_id TEXT,email TEXT,role TEXT,kind TEXT,state TEXT,project_id TEXT,payload JSONB,result JSONB)");
        const report={bindings:[{projectId:'prj-fixture',bindingId,instanceId,folderName:'fixture'}]};
        const now=new Date(),scan={schemaVersion:1,projectId:'prj-fixture',bindingId,instanceId,scanId:jobId,checkedAt:now.toISOString(),expiresAt:new Date(now.getTime()+900000).toISOString(),warnings:[],candidates:[{candidateId,provider:'team',name:'Imported',model:'imported-model-v1',modelVersion:'v1',capability:'chat',runtime:'remote-openai',baseUrl:endpoint,hasKey:true,credentialSource:'auth',blocker:null}],digest:''};scan.digest=modelScanDigest(scan);
        await pool.query("INSERT INTO bridge_devices VALUES($1,'qa',$2,false,now()+interval '1 hour')",[deviceId,JSON.stringify(report)]);
        await pool.query("INSERT INTO bridge_jobs VALUES($1,$2,'qa','Главный админ','scan-opencode-models','succeeded','prj-fixture',$3,$4)",[jobId,deviceId,JSON.stringify({bindingId,instanceId}),JSON.stringify(scan)]);
        let permitted=true;
        const modelService={pool,requireMain:async()=>{if(!permitted)throw Error('Role revoked');return 'qa';},resolveProject:async()=>({id:'prj-fixture'})};
        const devices={owned:async(actor,id)=>{const result=await pool.query('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked',[id,actor.email]);if(!result.rows[0])throw Error('Not owned');return result.rows[0];}};
        const importer=new OpenCodeModelImport(modelService,devices),input={deviceId,jobId,candidateId};
        const imported=await importer.import({},input);assert.equal(imported.hasKeyOnComputer,true);assert.equal(imported.model.runtime,'remote-openai');assert.equal('apiKey'in imported.model,false);
        assert.equal((await importer.import({},input)).model.id,imported.model.id);assert.equal((await importer.import({},input)).repeated,true);
        assert.equal(await privateRepo.head(imported.model.id),null,'Import metadata must not impersonate the local credential');
        permitted=false;await assert.rejects(importer.import({},input),/Role revoked/);permitted=true;
        await pool.query("UPDATE bridge_devices SET email='another-owner' WHERE id=$1",[deviceId]);await assert.rejects(importer.import({},input),/Not owned/);await pool.query("UPDATE bridge_devices SET email='qa' WHERE id=$1",[deviceId]);
        await pool.query("UPDATE bridge_devices SET report='{}' WHERE id=$1",[deviceId]);await assert.rejects(importer.import({},input));
        await pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[deviceId,JSON.stringify(report)]);
        scan.checkedAt=new Date(Date.now()-3600000).toISOString();scan.expiresAt=new Date(Date.now()-2700000).toISOString();scan.candidates[0].model='expired-model';scan.digest=modelScanDigest(scan);
        await pool.query('UPDATE bridge_jobs SET result=$2 WHERE id=$1',[jobId,JSON.stringify(scan)]);await assert.rejects(importer.import({},input),/истёк/);
    });
    await check('Native supply installs immutable aliases; concurrent historical pins with one public name remain independently usable',async()=>{
        const {packModelBundle}=await import(pathToFileURL(path.join(root,'scripts/models/bundle.mjs')).href);
        const hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
        temporary=await realpath(await mkdtemp(path.join(tmpdir(),'nc-imported-model-')));const target=path.join(temporary,'target');
        const fixture=async(version)=>{
            const source=path.join(temporary,'source-'+version),output=path.join(temporary,'parts-'+version);
            await mkdir(path.join(source,'models/blobs'),{recursive:true});
            const config=Buffer.from('fixture-config-'+version),weights=Buffer.from('fixture-weights-'+version),manifest={schemaVersion:2,config:{digest:'sha256:'+hash(config),size:config.length},layers:[{digest:'sha256:'+hash(weights),size:weights.length}]},manifestBytes=Buffer.from(JSON.stringify(manifest));
            for(const bytes of [config,weights])await writeFile(path.join(source,'models/blobs/sha256-'+hash(bytes)),bytes);
            await mkdir(path.join(source,'models/manifests/registry.ollama.ai/library/fixture-native'),{recursive:true});await writeFile(path.join(source,'models/manifests/registry.ollama.ai/library/fixture-native/v1'),manifestBytes);
            const lock={schemaVersion:1,model:'fixture-native:v1',manifest,manifestSha256:hash(manifestBytes)};
            const bundle=await packModelBundle({directory:source,output,baseUrl:'https://github.com/ghost-raven1/neurocenter-assets/releases/download/models-fixture.'+version,locks:[lock],partBytes:8});
            const parts=bundle.files.flatMap(file=>(file.parts||[]).map(part=>({name:part.name,sha256:part.sha256,bytes:part.size,path:path.join(output,part.name)})));
            const model={...original,id:'model-native',runtime:'ollama',model:lock.model,manifestSha256:lock.manifestSha256,verificationSha256:undefined};
            return {lock,bundle,parts,model};
        };
        const first=await fixture(1),second=await fixture(2),supplies=new Map([first,second].map(value=>[value.lock.manifestSha256,value]));
        let override;const installer=new ModelBundleRuntime({modelSupply:async(_id,sha)=>override||supplies.get(sha)});process.env.MODEL_STORAGE_PATH=target;
        const controller=new AbortController(),progress=[];
        override={...first,parts:first.parts.slice(1)};await assert.rejects(installer.prepare(first.model,async value=>{progress.push(value);},controller.signal),/зарегистрирована/);
        override=undefined;const originalPart=await readFile(first.parts[0].path);await writeFile(first.parts[0].path,Buffer.alloc(originalPart.length,1));await assert.rejects(installer.prepare(first.model,async()=>{},controller.signal),/SHA/);await writeFile(first.parts[0].path,originalPart);
        await Promise.all([first,second].map(value=>installer.prepare(value.model,async event=>{progress.push(event);},controller.signal)));
        const aliasPath=model=>path.join(target,'models/manifests/registry.ollama.ai',...localModelAlias(model).split(':'));
        for(const value of [first,second]){
            assert.equal(hash(await readFile(aliasPath(value.model))),value.lock.manifestSha256);
            for(const file of value.bundle.files.filter(file=>file.parts))assert.equal(hash(await readFile(path.join(target,file.path))),file.sha256);
        }
        await assert.rejects(readFile(path.join(target,'models/manifests/registry.ollama.ai/library/fixture-native/v1')),error=>error.code==='ENOENT');
        await Promise.all([first,second,first].map(value=>installer.prepare(value.model,async()=>{},controller.signal)));
        assert.ok(progress.some(item=>item.stage==='activating'));
        const calls=[],runtime=createServer(async(req,res)=>{
            try{
                calls.push(req.url);let body;const chunks=[];for await(const chunk of req)chunks.push(chunk);if(chunks.length)body=JSON.parse(Buffer.concat(chunks));
                res.setHeader('content-type','application/json');
                if(req.url==='/api/tags')return res.end(JSON.stringify({models:await Promise.all([first,second].map(async value=>({name:localModelAlias(value.model),digest:hash(await readFile(aliasPath(value.model)))})))}));
                assert.equal(req.url,'/api/embed');assert.ok(body.model.startsWith('neurocenter/'));assert.notEqual(body.model,first.model.model);
                const selected=[first,second].find(value=>localModelAlias(value.model)===body.model);assert.ok(selected);
                assert.equal(hash(await readFile(aliasPath(selected.model))),selected.lock.manifestSha256);
                res.end(JSON.stringify({model:body.model,embeddings:body.input.map(()=>[selected===first?1:2,1,3])}));
            }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
        });
        await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
        try{
            const client=new OllamaClient({env:{MODEL_RUNTIME_URL:'http://127.0.0.1:'+runtime.address().port}});
            const [oldPin,newPin]=await Promise.all([first,second].map(value=>client.infer(value.model,'embed',{input:['historical project']})));
            assert.deepEqual(oldPin.embeddings,[[1,1,3]]);assert.deepEqual(newPin.embeddings,[[2,1,3]]);assert.equal(oldPin.model,newPin.model);assert.equal(oldPin.model,first.model.model);
            assert.equal(calls.some(url=>url.includes('pull')),false);
        }finally{runtime.closeAllConnections();await new Promise(resolve=>runtime.close(resolve));}
        const invalid=new ModelBundleRuntime({modelSupply:async()=>{throw Error('Supply missing');}});await assert.rejects(invalid.prepare(first.model,async()=>{},controller.signal),/Supply missing/);
    });
    await check('Creation receipts are idempotent and history ordinals never overwrite snapshot-only versions',async()=>{
        const input={name:'Idempotent metadata',runtime:'remote-openai',capability:'embedding',model:'idempotent-v1',modelVersion:'v1',dimension:3},key=require('node:crypto').randomUUID();
        const [a,b]=await Promise.all([models.create(input,'qa',key),models.create(input,'qa',key)]);assert.equal(a.id,b.id);
        await assert.rejects(models.create({...input,name:'Different payload'},'qa',key),/других параметров/);
        const row=(await pool.query('SELECT * FROM model_catalog WHERE id=$1',[a.id])).rows[0];
        await saveModelVersion(pool,{...row,revision:7,name:'Snapshot-only retained'});
        assert.equal(await nextModelRevision(pool,a.id,a.revision),8);
        await assert.rejects(saveModelVersion(pool,{...row,revision:7,name:'Different collision'}),/immutable snapshot/);
        const updated=await models.update(a.id,{expectedRevision:a.revision,name:'Changed head'},'qa');assert.equal(updated.revision,8);
        assert.equal((await pool.query('SELECT name FROM model_catalog_versions WHERE model_id=$1 AND revision=7',[a.id])).rows[0].name,'Snapshot-only retained');
    });
} catch(error){fatal=error;}
finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(temporary)await rm(temporary,{recursive:true,force:true});
    if(originalStorage===undefined)delete process.env.MODEL_STORAGE_PATH;else process.env.MODEL_STORAGE_PATH=originalStorage;
    if(pool)await pool.end();
    if(created){await admin.query('DROP DATABASE "'+database+'"');removed=true;}
    const after=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate')).rows.map(row=>row.datname);await admin.end();
    if(originalKey===undefined)delete process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY;else process.env.NEUROCENTER_MODEL_CREDENTIAL_KEY=originalKey;
    const report={checks,ownDatabaseDropped:removed,existingDatabasesPreserved:before.every(name=>after.includes(name)),unexpectedDatabases:after.filter(name=>!before.includes(name)),fatal:fatal?.message};
    await mkdir(path.join(root,'output/remote-models'),{recursive:true});await writeFile(path.join(root,'output/remote-models/database-report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));if(fatal||checks.some(check=>!check.ok)||!removed||!report.existingDatabasesPreserved)process.exitCode=1;
}
