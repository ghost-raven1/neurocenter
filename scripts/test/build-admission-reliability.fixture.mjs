import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {publicationFixture} from './package-publication-rollback.fixture.mjs';
import {releaseCancellationLease} from './tool-build-cancellation-lease.mjs';
export {until} from './tool-build-cancellation.fixture.mjs';

export const root=fileURLToPath(new URL('../../',import.meta.url));
export const output=path.join(root,'.run/build-admission-reliability-20261023');
export const phase=process.env.BUILD_ADMISSION_PHASE??'candidate';
assert.ok(['baseline','candidate'].includes(phase),'Select the explicit baseline or candidate phase.');
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const failure=error=>({name:error?.name,message:String(error?.message??error).slice(0,1000),code:error?.code??error?.cause?.code,status:error?.getStatus?.()??error?.status??500});
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function deadline(promise,label,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('QA deadline: '+label)),ms);})]);}finally{clearTimeout(timer);}}
export const sqlGuc=async db=>(await db.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout,pg_backend_pid() AS pid")).rows[0];
export const uploadBuildInput=(source,label)=>({requestKey:randomUUID(),kind:'mcp',name:'Owned '+label+' '+randomUUID().slice(0,8),description:'Admission boundary',targets:['darwin-arm64'],source});
export const existingMcpInput=name=>({name,kind:'mcp',description:'Existing immutable card',tags:[],files:[{path:'index.mjs',content:'export default {};'}],config:{transport:'stdio',command:'node',args:['index.mjs'],entrypoint:'index.mjs'}});
export const skillInput=(slug='admission-'+randomUUID().slice(0,8))=>({requestKey:randomUUID(),kind:'skill',name:slug,description:'Owned admission recovery',targets:['darwin-arm64'],source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: '+slug+'\ndescription: Owned admission recovery\n---\n\nPreserved source.'}]}});

/** Admit the same input factories with frozen production validators before any database fixture exists. */
export function validateAdmissionInputs(){
    const candidate=process.env.BUILD_ADMISSION_CANDIDATE;assert.ok(candidate&&path.isAbsolute(candidate));
    const load=createRequire(path.join(candidate,'services/catalog-service/package.json'));
    const {validateBuildInput}=load(path.join(candidate,'services/catalog-service/dist/package-build/package-build.model.js'));
    const {validatePublication}=load(path.join(candidate,'services/catalog-service/dist/publication/publication-validation.js'));
    const raw=uploadBuildInput({type:'upload',uploadId:randomUUID(),sha256:'a'.repeat(64),bytes:64,entrypoint:'program'},'preflight');
    const create=validateBuildInput(raw),update=validateBuildInput({...raw,publication:{catalogId:'ai-plug-'+randomUUID(),expectedVersion:1,expectedSourceHash:'b'.repeat(64)}}),skill=validateBuildInput(skillInput('admission-preflight')),card=validatePublication(existingMcpInput(raw.name));
    for(const input of [create,update,skill])assert.deepEqual(input.targets,['darwin-arm64']);
    assert.deepEqual(card.config,{transport:'stdio',command:'node',args:['index.mjs'],entrypoint:'index.mjs'});
    assert.throws(()=>validateBuildInput({...skillInput('admission-invalid'),targets:[]}),error=>error.getStatus?.()===400);
    assert.throws(()=>validatePublication({...existingMcpInput(raw.name),config:{entrypoint:'index.mjs'}}),error=>error.getStatus?.()===400);
    return {accepted:['upload-create','upload-update','skill-create','existing-mcp-card'],targets:create.targets,mcpConfig:card.config,rejected:['empty-skill-targets','entrypoint-only-mcp'],scope:'Pure frozen compiled validators only; no database, upload inspection or native execution.'};
}

/** Source and emitted JS bindings are admitted before obtaining any PostgreSQL resource. */
export async function inputHashes(){
    const candidate=process.env.BUILD_ADMISSION_CANDIDATE,file=process.env.BUILD_ADMISSION_SOURCE_RECEIPT;
    assert.ok(candidate&&path.isAbsolute(candidate));assert.ok(file&&path.isAbsolute(file));
    const freeze=JSON.parse(await readFile(file)),hashes={sourceReceipt:sha(await readFile(file))};
    for(const source of freeze.sourceFiles){
        assert.ok(!path.isAbsolute(source)&&!source.split('/').includes('..'));
        const digest=sha(await readFile(path.join(candidate,source)));assert.equal(digest,freeze.hashes[source]);
        hashes['candidate-source:'+source]=digest;hashes['live-source:'+source]=sha(await readFile(path.join(root,source)));
        if(phase==='candidate')assert.equal(hashes['live-source:'+source],digest,'Live source drift: '+source);
    }
    const modules={
        'catalog-service':['package-build/package-build.service.js','package-build/package-build.repository.js','package-build/package-build.model.js','package-build/package-build.controller.js','package-build/publication-target.js','package-build/publication-deadline.js','package-build/build-skill.js','package-build/skill-source.js','source-upload/source-upload.service.js','source-upload/source-upload.repository.js','source-upload/source-upload.files.js','source-upload/source-upload.model.js','source-upload/stage-upload.js','asset-sources/local-skill-ingest.js','asset-sources/skill-adapter.js','asset-sources/asset-blob-store.js','access/access-db.js','publication/plugin-repository.js','publication/publication-validation.js'],
        'skills-service':['skills/skills.service.js','skills/asset-import.controller.js','skills/asset-import.js','storage/fs-skills-storage.js','storage/skill-journal.js'],
    };
    for(const [name,files]of Object.entries(modules)){
        const manifestFile=path.resolve(candidate,'..',name+'-artifacts.json'),manifest=JSON.parse(await readFile(manifestFile));hashes[name+'-manifest']=sha(await readFile(manifestFile));
        for(const relative of files){const digest=sha(await readFile(path.join(candidate,'services',name,'dist',relative)));assert.equal(digest,manifest.files[relative]);hashes['compiled:'+name+'/'+relative]=digest;}
    }
    for(const file of ['build-admission-reliability.mjs','build-admission-reliability.fixture.mjs','package-publication-rollback.fixture.mjs','owned-postgres.fixture.mjs','tool-build-cancellation.fixture.mjs','tool-build-cancellation-lease.mjs'])hashes['qa:'+file]=sha(await readFile(path.join(root,'scripts/test',file)));
    return hashes;
}

/** One real database, upload store, worker lease and native skill journal belong exclusively to this case. */
export async function admissionFixture(label,runDirectory){
    const original={...process.env},aliases={PACKAGE_PUBLICATION_ROLLBACK_CONNECTION_FILE:'BUILD_ADMISSION_CONNECTION_FILE',PACKAGE_PUBLICATION_ROLLBACK_CANDIDATE:'BUILD_ADMISSION_CANDIDATE',PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT:'BUILD_ADMISSION_SOURCE_RECEIPT'};
    for(const source of Object.values(aliases))assert.ok(process.env[source]&&path.isAbsolute(process.env[source]));
    for(const [target,source]of Object.entries(aliases))process.env[target]=process.env[source];
    process.env.PACKAGE_PUBLICATION_ROLLBACK_RECEIPT_NAME='b13-'+phase+'-'+label+'-'+randomUUID()+'.json';
    const restore=()=>{for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);};
    let f,service,raw,released=false,closePromise;const pending=[],blockers=new Set(),traces=[],prepared=[];
    const track=promise=>{const item={pending:true};item.promise=Promise.resolve(promise).then(value=>{item.pending=false;return item.result={ok:true,value};},error=>{item.pending=false;return item.result={ok:false,error};});pending.push(item);return item;};
    async function close(){
        if(closePromise)return closePromise;
        closePromise=(async()=>{
            const errors=[];const attempt=async(resource,action)=>{try{await action();}catch(error){errors.push({resource,...failure(error)});}};
            for(const blocker of blockers)await attempt('owned blocker',()=>blocker.release());
            if(service){service.stopping=true;clearTimeout(service.retryTimer);service.retryTimer=undefined;}
            const drain=()=>Promise.all([...pending.map(item=>item.promise),service?.worker,service?.leaseUse,service?.recovering].filter(Boolean));
            try{await deadline(drain(),'case operations cleanup');}
            catch(error){
                errors.push({resource:'operation drain',...failure(error)});
                const ownBackend=async(pid,command)=>{const row=(await f.observer.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',[pid])).rows[0];if(row)await f.observer.query('SELECT '+command+'($1)',[pid]);};
                for(const pid of new Set(traces.map(item=>item.pid)))await attempt('cancel owned backend',()=>ownBackend(pid,'pg_cancel_backend'));
                try{await deadline(drain(),'cancelled case cleanup',5000);}catch(second){errors.push({resource:'drain after cancellation',...failure(second)});for(const pid of new Set(traces.map(item=>item.pid)))await attempt('terminate only owned database backend',()=>ownBackend(pid,'pg_terminate_backend'));await attempt('drain after termination',()=>deadline(drain(),'terminated case cleanup',5000));}
            }
            if(service?.lease){const owned=service.lease;await attempt('current worker lease',async()=>{await owned.query('SELECT pg_advisory_unlock(72465395)');service.releaseLease?.();if(owned===raw)released=true;});service.lease=undefined;service.releaseLease=undefined;}
            if(raw&&!released)await attempt('initial worker lease',async()=>{released=true;await releaseCancellationLease(raw);});
            if(f)await attempt('own staging',()=>rm(path.join(f.own,'runtime','.build-staging'),{recursive:true,force:true}));
            let result;await attempt('owned database',async()=>{result=await deadline(f?.close(),'owned database disposal',15000);});restore();
            return {errors,ownDatabaseDropped:result?.ownDatabaseDropped===true,originalDatabasesPreserved:result?.originalDatabasesPreserved===true,fixtureErrors:result?.cleanupErrors??[]};
        })();return closePromise;
    }
    try{
        f=await publicationFixture();f.own=path.join(runDirectory,label);await mkdir(f.own,{recursive:true,mode:0o700});process.env.RUNTIME_ARTIFACT_DIR=path.join(f.own,'runtime');
        const native=await f.skillSources(label);await native.skills.onApplicationBootstrap();
        const source={...native.source,prepareLocalSkill:async(...args)=>{const item=await native.source.prepareLocalSkill(...args);prepared.push(item);return item;}};
        service=f.createService(source);const uploads=new(f.load('source-upload/source-upload.service.js').SourceUploads)(f.pool,path.join(f.own,'uploads'));await uploads.setup();service.uploads=uploads;f.extras.push(()=>uploads.stop());
        const actor={email:f.actor,activeRole:'Главный админ'},request={headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))}},controller=new(f.load('package-build/package-build.controller.js').PackageBuildController)(service);
        const repository=service.repository,writer=f.writer();raw=await writer.connect();raw.on('error',()=>{});await raw.query('SET lock_timeout=0');await raw.query('SET statement_timeout=0');await raw.query('SELECT pg_advisory_lock(72465395)');
        service.lease=raw;service.releaseLease=destroy=>{if(!released){released=true;raw.release(destroy);}};
        const kick=service.startWorker.bind(service);service.startWorker=()=>{};
        const transaction=repository.transaction.bind(repository),proxies=new WeakMap();
        const observed=client=>{
            if(proxies.has(client))return proxies.get(client);
            const proxy=new Proxy(client,{get(target,key){
                if(key==='query')return async(sql,...args)=>{
                    const text=typeof sql==='string'?sql:sql.text;
                    if(!/FOR UPDATE|pg_advisory_xact_lock|UPDATE tool_build_jobs/.test(text))return target.query(sql,...args);
                    const guc=await sqlGuc(target),entry={sql:text.replace(/\s+/g,' ').trim(),values:args[0],pid:Number(guc.pid),guc,started:performance.now()};traces.push(entry);
                    try{const result=await target.query(sql,...args);entry.completed=true;return result;}
                    catch(error){entry.error=failure(error);throw error;}finally{entry.elapsedMs=performance.now()-entry.started;}
                };
                const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
            }});proxies.set(client,proxy);return proxy;
        };
        // Original transaction still owns BEGIN, policy, COMMIT, rollback and release; only work SQL is observed.
        repository.transaction=(work,borrowed)=>transaction(client=>work(observed(client)),borrowed);
        const hold=async(sql,values)=>{
            const client=await f.pool.connect();let done=false;const blocker={pid:0,release:async()=>{if(done)return;done=true;try{await client.query('ROLLBACK');}finally{client.release();}}};blockers.add(blocker);
            try{await client.query('SET lock_timeout=0');await client.query('SET statement_timeout=0');await client.query('BEGIN');await client.query(sql,values);blocker.pid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);return blocker;}
            catch(error){await blocker.release();throw error;}
        };
        const graph=async()=>(await f.observer.query('SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 ORDER BY pid')).rows;
        const ready=async()=>{
            // Actual inspected bytes, deliberately never executed: this case accepts source, not a runnable tool.
            const bytes=Buffer.alloc(64);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x100000c,4);bytes.writeUInt32LE(2,12);bytes.writeUInt32LE(1,16);bytes.writeUInt32LE(24,20);bytes.writeUInt32LE(0x32,32);bytes.writeUInt32LE(24,36);bytes.writeUInt32LE(1,40);
            const intent={requestKey:randomUUID(),name:'program',sha256:sha(bytes),bytes:bytes.length},created=await uploads.create(actor,intent),upload=await uploads.content(actor,created.id,Readable.from([bytes]),bytes.length);
            assert.equal(upload.state,'READY');assert.equal(upload.metadata.entrypoint,'program');assert.deepEqual(upload.metadata.supportedTargets,['darwin-arm64']);
            const inspect=async()=>{const row=await uploads.get(actor,upload.id),actual=await readFile(uploads.files.filename(upload.id));assert.equal(row.state,'READY');assert.equal(sha(actual),intent.sha256);assert.deepEqual(actual,bytes);return {id:row.id,state:row.state,sha256:sha(actual),bytes:actual.length,metadata:row.metadata};};
            return {upload,inspect,source:{type:'upload',uploadId:upload.id,sha256:upload.sha256,bytes:upload.bytes,entrypoint:'program'}};
        };
        const runQueue=async(input=skillInput())=>{
            service.startWorker=kick;if(!service.lease){const recovery=track(service.recoverOwnership()),result=await deadline(recovery.promise,'actual worker recovery');if(!result.ok)throw result.error;}
            const queued=await controller.create(request,input);kick(path.join(f.own,'runtime','.build-staging'));
            const stop=new AbortController(),polling=track((async()=>{while(!stop.signal.aborted){const row=await repository.get(queued.id);if(['FAILED','SUCCEEDED','CANCELLED'].includes(row.state))return row;await delay(25);}throw stop.signal.reason;})());
            try{const result=await deadline(polling.promise,'independent actual skill queue');if(!result.ok)throw result.error;const terminal=result.value;assert.equal(terminal.state,'SUCCEEDED',terminal.error??terminal.message);return {id:terminal.id,state:terminal.state,result:terminal.result};}
            finally{stop.abort(Error('Owned terminal polling stopped'));await polling.promise;}
        };
        return {...f,service,repository,controller,request,actor,raw,native,prepared,traces,track,hold,graph,ready,skillInput,runQueue,kick,close};
    }catch(error){const cleanup=await close();throw new AggregateError([error,...cleanup.errors],'Admission fixture initialization failed',{cause:error});}
}
