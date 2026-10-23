import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {actorFixture,causalActorRed,inputHashes,deferred,settled,until,deadline,releaseCancellationLease,failure,root,output,phase,sha} from './actor-canonical-publication.fixture.mjs';
assert.ok(process.platform!=='win32'&&Number(process.versions.node.split('.')[0])>=24,'Node24/POSIX required.');
const initial=await inputHashes();await mkdir(output,{recursive:true});const directory=await mkdtemp(path.join(output,phase+'-'));
const receipt={schemaVersion:1,phase,startedAt:new Date().toISOString(),inputHashes:initial,cases:[],cleanupErrors:[],limits:[
    'Real AuthService.mockUser uses loopback profile HTTP -> actual AccessController.profile/AccessDb.claims. No real IdP or OAuth browser flow.',
    'Actual ProxyService.buildHeaders and PackageBuildController actor decoding are called in-process; this is not full Gateway HTTP/middleware acceptance.',
    'Real Service.execute skill and controller.importAsset, SQL/native storage/audit/source bytes. No runtime JS builder, paid inference or user bridge.',
    'Durable controls invoke actual create/startWorker/replay/request/cancel; delegated barriers follow completed real SQL methods and do not replace results.',
]};
const rawFor=(canonical,format)=>format==='case'?canonical.toUpperCase():format==='spaces'?'  '+canonical+'  ':canonical;
const absent=filename=>stat(filename).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;});
const configFor=slug=>({kind:'skill',name:'Owned '+slug,description:'Raw actor publication regression',tags:[],targets:['darwin-arm64'],source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: '+slug+'\ndescription: Raw actor publication regression\n---\n\nOwned actor source.'}]}});

async function one(type,format,mode){
    const label=[type,format,mode].filter(Boolean).join('-'),e={type,format,mode,nativePublishes:[],audit:[]};let f,service,native,raw,released=false,executing,stageRoot,prepared,workerGate,lateGate;
    try{
        f=await actorFixture(label,directory);const slug='owned-principal-'+randomUUID().slice(0,12),canonical=f.actor,rawActor=rawFor(canonical,format),config=configFor(slug),key=randomUUID();e.canonical=canonical;
        native=await f.skillSources(slug);const storage=native.skills.storage,deliver=storage.auditOutbox.deliver.bind(storage.auditOutbox);storage.auditOutbox.deliver=async events=>{e.audit.push(...structuredClone(events));return deliver(events);};await native.skills.onApplicationBootstrap();
        const client=native.ingest.adapter.client,requestNative=client.request;client.request=async(url,options)=>{const body=options.body?JSON.parse(options.body):undefined;if(String(url).endsWith('/publish'))e.nativePublishes.push({actor:body.actor,requestKey:body.requestKey});return requestNative(url,options);};
        const source={...native.source,prepareLocalSkill:async(...args)=>{prepared=await native.source.prepareLocalSkill(...args);return prepared;}};service=f.createService(source);
        const repository=new(f.load('package-build/package-build.repository.js').PackageBuildRepository)(f.pool,client=>service.discardLease(client));service.repository=repository;
        const writer=f.writer();raw=await writer.connect();await raw.query('SELECT pg_advisory_lock(72465395)');service.lease=raw;service.releaseLease=destroy=>{if(!released){released=true;raw.release(destroy);}};
        stageRoot=path.join(f.own,'stage');await mkdir(stageRoot,{mode:0o700});
        if(type==='malformed'){
            const bad='invalid@@example.test',login=await settled(f.identity(service,bad));assert.equal(login.ok,false);e.login=failure(login.error);assert.ok(f.profileRequests.length===1&&f.profileRequests[0].status!==200);e.profile=f.profileRequests;
            const controller=new(f.load('package-build/package-build.controller.js').PackageBuildController)(service),request={headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:bad,activeRole:'Главный админ'}))}};
            const result=await settled(controller.importAsset(request,{requestKey:key,asset:{}}));assert.equal(result.ok,false);e.importFailure=failure(result.error);assert.equal(e.importFailure.status,403);
            const skill=await settled(native.skills.inspectAssetSkill('common/'+slug));assert.equal(skill.ok,false);assert.equal(skill.error.getStatus(),404);assert.equal(e.nativePublishes.length,0);assert.equal(Number((await f.observer.query('SELECT count(*)::int AS n FROM asset_source_receipts')).rows[0].n),0);e.noNative=true;e.ok=true;return;
        }
        const identity=await f.identity(service,rawActor);e.identity=identity.trace;
        const role=async email=>(await f.observer.query('SELECT email,is_main_admin,enabled FROM platform_users WHERE email=$1',[email])).rows[0]??null;e.roleRows={canonical:await role(canonical),raw:await role(rawActor)};assert.equal(e.identity.profile.canonicalEmail,canonical);assert.ok(e.identity.profile.roles.includes('Главный админ'));
        if(type==='durable'){
            const take=repository.takeQueued.bind(repository),entered=deferred();workerGate=deferred();let used=false;
            repository.takeQueued=async(...args)=>{const row=await take(...args);if(row?.request_key===key&&!used){used=true;entered.resolve(row);await workerGate.promise;}return row;};
            const input={requestKey:key,...config},queued=await identity.controller.create(identity.request,input);await deadline(entered.promise,'actual worker took raw-owner job');
            const before=await repository.get(queued.id),count=Number((await f.observer.query('SELECT count(*)::int AS n FROM tool_build_jobs')).rows[0].n);
            assert.equal(before.actor,rawActor);assert.deepEqual(before.config,config);const replay=await identity.controller.create(identity.request,input),found=await identity.controller.request(identity.request,key);assert.equal(replay.id,queued.id);assert.equal(found.id,queued.id);
            const canonicalRequest={headers:{...identity.request.headers,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:canonical,activeRole:'Главный админ'}))}};
            const other=await settled(identity.controller.request(canonicalRequest,key));assert.equal(other.ok,false);assert.equal(other.error.getStatus(),404);
            const cancelled=await identity.controller.cancel(identity.request,queued.id);assert.equal(cancelled.state,'CANCELLING');workerGate.resolve();await until(async()=> (await repository.get(queued.id)).state==='CANCELLED','real worker completed cancellation');await until(()=>!service.worker,'real worker drained');
            const final=await repository.get(queued.id);assert.equal(final.actor,rawActor);assert.equal(final.request_hash,before.request_hash);assert.deepEqual(final.config,before.config);assert.equal(Number((await f.observer.query('SELECT count(*)::int AS n FROM tool_build_jobs')).rows[0].n),count);
            const lateKey=randomUUID(),existing=repository.existing.bind(repository),read=deferred();lateGate=deferred();repository.existing=async(actor,key,...rest)=>{const value=await existing(actor,key,...rest);if(key===lateKey&&!value){read.resolve();await lateGate.promise;}return value;};
            executing=settled(identity.controller.create(identity.request,{...input,requestKey:lateKey}));await deadline(read.promise,'late create real existing read');const tombstone=await identity.controller.cancelRequest(identity.request,lateKey);assert.equal(tombstone.state,'CANCELLED');lateGate.resolve();const late=await deadline(executing,'late create after durable raw cancellation');assert.equal(late.ok,false);assert.equal(late.error.getStatus(),409);
            const cancelledKeys=(await f.observer.query('SELECT actor,request_key FROM tool_build_cancellations ORDER BY request_key')).rows;assert.equal(cancelledKeys.length,2);assert.ok(cancelledKeys.every(row=>row.actor===rawActor));assert.ok(cancelledKeys.some(row=>row.request_key===lateKey));assert.equal(Number((await f.observer.query('SELECT count(*)::int AS n FROM tool_build_jobs')).rows[0].n),count);assert.equal(e.nativePublishes.length,0);
            const operations=(await f.observer.query('SELECT actor,state FROM operations WHERE operation_id=$1',['tool-build-'+queued.id])).rows;assert.equal(operations.length,1);assert.equal(operations[0].actor,rawActor);assert.equal(operations[0].state,'CANCELLED');assert.equal((await repository.get(queued.id)).actor,rawActor);
            e.rawOwnerPreserved=true;e.sameReplayId=queued.id;e.canonicalCounterpartStatus=404;e.cancelledState=final.state;e.tombstones=cancelledKeys;e.lateCreateStatus=409;e.unchangedRequestHash=before.request_hash;e.operations=operations;e.ok=true;return;
        }
        let build;
        if(mode==='build'){
            const queued=await repository.enqueue(rawActor,key,'owned-principal-'+key,config);build=await repository.takeQueued(raw);assert.equal(build.id,queued.id);executing=settled(service.execute(build,stageRoot));
        }else{
            const built=await f.load('package-build/build-skill.js').buildSkillAsset(config,stageRoot),descriptor=built.asset.source,blobs=new(f.load('asset-sources/asset-blob-store.js').AssetBlobStore)(f.pool,path.join(native.folder,'blobs'));
            assert.equal(descriptor.type,'archive');await blobs.ingestLocal([{archivePath:built.sourceFile.archivePath,sha256:descriptor.sha256,bytes:descriptor.bytes,filename:descriptor.sha256+'.source'}],key);executing=settled(identity.controller.importAsset(identity.request,{requestKey:key,asset:built.asset}));
        }
        const ended=await deadline(executing,'actual principal skill publication');e.operation=ended.ok?{ok:true,result:ended.value}:{ok:false,error:failure(ended.error)};
        if(build){const row=await repository.get(build.id);e.job={id:row.id,actor:row.actor,state:row.state,error:row.error,result:row.result};assert.equal(row.actor,rawActor);}
        assert.ok(prepared);const snapshot=await settled(native.skills.inspectAssetSkill('common/'+slug));if(snapshot.ok)e.native={exists:true,...snapshot.value};else{assert.equal(snapshot.error.getStatus(),404);e.native={exists:false};}await storage.flushSkillAudit();
        e.sourceRows={versions:Number((await f.observer.query('SELECT count(*)::int AS n FROM asset_source_versions WHERE external_id=$1',[prepared.asset.id])).rows[0].n),receipts:Number((await f.observer.query('SELECT count(*)::int AS n FROM asset_source_receipts WHERE external_id=$1',[prepared.asset.id])).rows[0].n)};
        const descriptor=prepared.asset.source,bytes=await readFile(path.join(native.folder,'blobs',descriptor.sha256+'.blob'));assert.equal(sha(bytes),descriptor.sha256);assert.equal(bytes.length,descriptor.bytes);assert.deepEqual(JSON.parse(bytes).files,config.source.files);e.retainedSource={sha256:sha(bytes),bytes:bytes.length,exact:true};
        const succeeded=mode==='build'?e.job.state==='SUCCEEDED':ended.ok;assert.equal(succeeded,true,'Authorized raw principal failed skill publication');assert.equal(e.native.exists,true);assert.equal(e.native.version,1);assert.equal(e.nativePublishes.length,1);assert.equal(e.nativePublishes[0].actor,canonical);assert.equal(e.nativePublishes[0].requestKey,prepared.item.requestKey);assert.equal(e.audit.length,1);assert.equal(e.audit[0].actor,canonical);assert.deepEqual(e.sourceRows,{versions:1,receipts:1});
        const row=(await f.observer.query('SELECT * FROM asset_source_receipts WHERE external_id=$1',[prepared.asset.id])).rows[0],version=(await f.observer.query('SELECT * FROM asset_source_versions WHERE external_id=$1',[prepared.asset.id])).rows[0];assert.equal(row.native_id,e.native.id);assert.equal(row.native_version,1);assert.equal(row.native_hash,e.native.hash);assert.equal(row.descriptor_sha256,prepared.sha256);assert.equal(row.imported_by,rawActor);assert.equal(version.imported_by,rawActor);for(const field of ['external_id','asset_version','descriptor_sha256','native_id','native_version','native_hash'])assert.deepEqual(version[field],row[field]);
        e.nativeActorCanonical=true;e.rawSourceActorPreserved=row.imported_by;e.immutableSource={assetId:row.external_id,sourceVersion:row.asset_version,sourceSha256:row.descriptor_sha256,nativeId:row.native_id,nativeVersion:row.native_version};e.ok=true;
    }catch(error){e.failure=failure(error);receipt.failures??=[];receipt.failures.push({label,...e.failure});}
    finally{
        workerGate?.resolve();lateGate?.resolve();if(executing)try{await deadline(executing,'owned current operation cleanup',10000);}catch(error){receipt.cleanupErrors.push({label,resource:'operation',...failure(error)});}
        if(service)try{await until(()=>!service.worker,'owned worker cleanup',10000);}catch(error){receipt.cleanupErrors.push({label,resource:'worker',...failure(error)});service.stopping=true;}
        if(service){service.lease=undefined;service.releaseLease=undefined;}if(raw&&!released)try{released=true;await releaseCancellationLease(raw);}catch(error){receipt.cleanupErrors.push({label,resource:'lease',...failure(error)});}
        if(stageRoot)try{await rm(stageRoot,{recursive:true,force:true});e.stageRemoved=await absent(stageRoot);}catch(error){receipt.cleanupErrors.push({label,resource:'own source stage',...failure(error)});}
        if(f)try{const end=await f.close();e.cleanup={ownDatabaseDropped:end.ownDatabaseDropped,originalDatabasesPreserved:end.originalDatabasesPreserved,errors:end.cleanupErrors};if(!end.ownDatabaseDropped||!end.originalDatabasesPreserved||end.cleanupErrors.length)throw Error('Actor fixture cleanup incomplete.');}catch(error){receipt.cleanupErrors.push({label,resource:'fixture',...failure(error)});}receipt.cases.push(e);
    }
}
try{for(const format of ['case','spaces','canonical'])for(const mode of ['build','import'])await one('publication',format,mode);for(const format of ['case','spaces'])await one('durable',format);await one('malformed','invalid');}
catch(error){receipt.failures??=[];receipt.failures.push({label:'QA initialization',...failure(error)});}
finally{
    try{receipt.finalInputHashes=await inputHashes();assert.deepEqual(receipt.finalInputHashes,initial);}catch(error){receipt.cleanupErrors.push({resource:'source stability',...failure(error)});}
    receipt.finishedAt=new Date().toISOString();receipt.causalRed=causalActorRed(receipt);receipt.ok=receipt.cases.length===9&&receipt.cases.every(item=>item.ok)&&!receipt.cleanupErrors.length&&!receipt.failures?.length;
    const file=path.join(directory,'receipt.json');await writeFile(file,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({ok:receipt.ok,causalRed:receipt.causalRed,cases:receipt.cases.length,receipt:path.relative(root,file),sha256:sha(await readFile(file))}));if(!receipt.ok)process.exitCode=1;
}
