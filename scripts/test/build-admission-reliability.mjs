import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {admissionFixture,deadline,delay,existingMcpInput,failure,inputHashes,output,phase,sha,sqlGuc,until,uploadBuildInput,validateAdmissionInputs} from './build-admission-reliability.fixture.mjs';

assert.ok(process.platform!=='win32'&&Number(process.versions.node.split('.')[0])>=24,'This native acceptance requires Node24/POSIX.');
const initial=await inputHashes(),inputAdmission=validateAdmissionInputs();await mkdir(output,{recursive:true});const directory=await mkdtemp(path.join(output,phase+'-'));
const receipt={schemaVersion:1,phase,startedAt:new Date().toISOString(),inputHashes:initial,inputAdmission,cases:[],cleanupErrors:[],limits:[
    'Real compiled Controller methods, Service.create, repository, PostgreSQL locks, READY upload bytes and native skill journal. Controller dispatch is in-process; Gateway/Nest middleware/browser are not accepted.',
    'Source upload uses inspected header-fixture bytes which are never executed. No JS/tool builder, bridge installation or external dependency is accepted.',
    'Watchdogs diagnose and drain owned operations; no artificial timeout error replaces production SQL. Per-lock/per-statement caps do not prove an overall transaction or HTTP deadline.',
    'Existing raw actor, request UUID, source pins and all publication/cancellation guards remain production-owned. No schema or product configuration is changed.',
]};
const outcome=item=>item.result?.ok?{ok:true,value:item.result.value}:{ok:false,error:failure(item.result?.error)};
const queueSql='SELECT pg_advisory_xact_lock(72465396)';
const activeCode=entry=>entry.error?.code;

async function one(boundary,limits){
    const label=limits?'inherited-'+limits.name:boundary,e={label,boundary,control:!!limits||boundary==='healthy'};let f,blocker,posted,cancelled,worker,input,upload,targetBefore,targetId;
    try{
        f=await admissionFixture(label,directory);upload=await f.ready();e.sourceBefore=await upload.inspect();
        input=uploadBuildInput(upload.source,label);
        if(limits){await f.raw.query('SET lock_timeout='+limits.lock);await f.raw.query('SET statement_timeout='+limits.statement);}
        e.sessionBefore=await sqlGuc(f.raw);
        if(boundary==='update-asset'||boundary==='update-graph'){
            const card=await new(f.load('publication/plugin-repository.js').PluginRepository)(f.pool).create(existingMcpInput(input.name),f.actor.email);
            targetId=card.id;const preview=await f.controller.publicationTarget(f.request,'mcp',card.id);input.publication={catalogId:card.id,expectedVersion:preview.expectedVersion,expectedSourceHash:preview.expectedSourceHash};
            targetBefore={head:(await f.pool.query('SELECT * FROM ai_plugins WHERE id=$1',[card.id])).rows,versions:(await f.pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[card.id])).rows,origins:(await f.pool.query('SELECT * FROM asset_source_receipts WHERE native_id=$1 ORDER BY repository,external_id',[card.id])).rows};
            blocker=await f.hold('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[boundary==='update-asset'?'asset-management:mcp:'+card.id:'publication:dependency-graph']);
        }else if(boundary==='upload-row')blocker=await f.hold('SELECT * FROM tool_source_uploads WHERE id=$1 FOR UPDATE',[upload.upload.id]);
        else if(boundary==='queue'||limits)blocker=await f.hold(queueSql);
        else if(boundary==='fence-row'){
            input=f.skillInput();const begin=f.repository.beginPublication.bind(f.repository);
            f.repository.beginPublication=async(...args)=>{f.repository.beginPublication=begin;blocker=await f.hold('SELECT * FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[args[0]]);return begin(...args);};
        }
        if(boundary==='fence-row'){
            const queued=await f.controller.create(f.request,input);e.jobId=queued.id;f.service.startWorker=f.kick;f.kick(path.join(f.own,'runtime','.build-staging'));worker=f.track(f.service.worker);
            await until(()=>blocker,'blocker acquired immediately before the actual fence SQL',4000);
        }else posted=f.track(f.controller.create(f.request,input));
        if(boundary==='healthy'){
            const result=await deadline(posted.promise,'healthy actual admission');assert.equal(result.ok,true);e.post=outcome(posted);
        }else{
            e.blockerPid=blocker.pid;
            const edge=limits?await until(()=>f.traces.find(item=>item.sql===queueSql),'actual short-limit queue SQL',3000):await until(async()=>{const graph=await f.graph();const row=graph.find(item=>item.blockers.includes(blocker.pid));return row?{...row,graph}:false;},'actual admission SQL blocking edge',4000);if(!limits)e.edge=edge;
            const trace=limits?edge:f.traces.find(item=>item.pid===Number(edge.pid)&&!item.completed&&!item.error);assert.ok(trace,'Actual blocked statement must have a same-client GUC observation.');e.blockedGuc=trace.guc;
            if(!limits&&phase==='baseline'){assert.equal(trace.guc.lock_timeout,'0');assert.equal(trace.guc.statement_timeout,'0');}
            if(phase==='candidate'){assert.equal(trace.guc.lock_timeout,limits?.lock==='100'?'100ms':'5s');assert.equal(trace.guc.statement_timeout,limits?.statement==='200'?'200ms':'30s');}
            else if(limits){assert.equal(trace.guc.lock_timeout,limits.lock==='100'?'100ms':'0');assert.equal(trace.guc.statement_timeout,limits.statement==='200'?'200ms':'0');}
            if(!limits){
                const missing=await f.track(f.controller.request(f.request,input.requestKey)).promise;
                if(boundary==='fence-row'){assert.equal(missing.ok,true);assert.equal(missing.value.state,'RUNNING');assert.equal(missing.value.publicationStartedAt,null);}
                else{assert.equal(missing.ok,false);assert.equal(missing.error.getStatus(),404);}
                cancelled=f.track(f.controller.cancelRequest(f.request,input.requestKey));
                e.cancelGraph=await until(async()=>{const graph=await f.graph();return graph.length>=2?graph:false;},'concurrent cancellation waits on the real queue/job lock graph',3000);
            }
            const started=performance.now();
            if(!limits&&phase==='baseline'){
                await delay(8005);e.pendingMs=performance.now()-started;assert.ok((posted??worker).pending);assert.ok(cancelled.pending);e.expectedRed=true;
            }else if(boundary==='fence-row'){
                await until(()=>f.traces.some(item=>item.sql.startsWith('UPDATE tool_build_jobs')&&activeCode(item)==='55P03'),'bounded failed-receipt fallback while the same job row remains locked',14000);
                await deadline(worker.promise,'worker relinquishes after unconfirmed FAILED receipt',5000);
                await deadline(cancelled.promise,'bounded cancellation under the locked job row',5000);assert.equal(outcome(cancelled).error.status,503);
                assert.equal(f.service.lease,undefined);e.heldRow=(await f.pool.query('SELECT state,publication_started_at FROM tool_build_jobs WHERE id=$1',[e.jobId])).rows[0];assert.equal(e.heldRow.state,'RUNNING');assert.equal(e.heldRow.publication_started_at,null);
            }else{
                await deadline(posted.promise,'bounded SQL admission',8000);assert.equal(posted.result.ok,false);e.post=outcome(posted);
                assert.equal(e.post.error.code,limits?.code??'55P03');if(phase==='candidate')assert.equal(e.post.error.status,503);
                if(cancelled){await deadline(cancelled.promise,'tombstone after admission rollback',3000);assert.equal(cancelled.result.ok,true);assert.equal(cancelled.result.value.state,'CANCELLED');assert.equal(cancelled.result.value.build,null);}
            }
        }
        if(boundary==='fence-row'){
            e.heldRow=(await f.pool.query('SELECT state,publication_started_at FROM tool_build_jobs WHERE id=$1',[e.jobId])).rows[0];assert.equal(e.heldRow.state,'RUNNING');assert.equal(e.heldRow.publication_started_at,null);
            const native=await f.track(f.native.skills.inspectAssetSkill('common/'+input.name)).promise;assert.equal(native.ok,false);assert.equal(native.error.getStatus(),404);e.nativeAbsentWhileHeld=true;
        }
        await blocker?.release();
        if(posted)await deadline(posted.promise,'admission after owned unlock');if(cancelled)await deadline(cancelled.promise,'cancellation after owned unlock');
        if(boundary==='fence-row'){
            if(phase==='candidate'){const recovery=f.track(f.service.recoverOwnership()),result=await deadline(recovery.promise,'actual recovery after job-row unlock');if(!result.ok)throw result.error;}
            else await deadline(worker.promise,'baseline actual skill worker after unlock');
            const row=await f.repository.get(e.jobId);if(phase==='candidate')assert.equal(row.state,'FAILED');else assert.ok(['SUCCEEDED','CANCELLED'].includes(row.state),row.error??row.message);e.finalJob={id:row.id,state:row.state,publicationStartedAt:row.publication_started_at,error:row.error};
            const replay=await f.controller.create(f.request,input),found=await f.controller.request(f.request,input.requestKey);assert.equal(replay.id,row.id);assert.equal(found.id,row.id);
            const again=await f.controller.cancelRequest(f.request,input.requestKey);assert.equal(again.build.id,row.id);assert.equal(again.state,row.state);
            assert.ok(f.prepared.length);const descriptor=f.prepared[0].asset.source,bytes=await readFile(path.join(f.native.folder,'blobs',descriptor.sha256+'.blob'));assert.equal(sha(bytes),descriptor.sha256);assert.deepEqual(JSON.parse(bytes).files,input.source.files);e.retainedSkillSource={sha256:sha(bytes),bytes:bytes.length};
        }else{
            e.post=outcome(posted);e.cancel=cancelled?outcome(cancelled):undefined;
            if(posted.result.ok){const saved=posted.result.value,replay=await f.controller.create(f.request,input),found=await f.controller.request(f.request,input.requestKey);assert.equal(replay.id,saved.id);assert.equal(found.id,saved.id);const stopped=await f.controller.cancel(f.request,saved.id);assert.equal(stopped.state,'CANCELLED');e.replayId=saved.id;}
            else if(cancelled){const replay=await f.track(f.controller.create(f.request,input)).promise;assert.equal(replay.ok,false);assert.equal(replay.error.getStatus(),409);assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM tool_build_jobs WHERE actor=$1 AND request_key=$2',[f.actor.email,input.requestKey])).rows[0].n,0);e.tombstoneBlocksLatePost=true;}
            else{const retry=await f.controller.create(f.request,input),replay=await f.controller.create(f.request,input);assert.equal(retry.id,replay.id);assert.equal((await f.controller.cancel(f.request,retry.id)).state,'CANCELLED');e.replayId=retry.id;}
            const rows=(await f.pool.query('SELECT id,actor,request_key,config,state FROM tool_build_jobs WHERE actor=$1 AND request_key=$2',[f.actor.email,input.requestKey])).rows;assert.ok(rows.length<=1);e.exactRequestRows=rows;
            const nextInput={...input,requestKey:randomUUID()},next=await f.controller.create(f.request,nextInput),repeat=await f.controller.create(f.request,nextInput);assert.equal(repeat.id,next.id);assert.equal((await f.controller.cancel(f.request,next.id)).state,'CANCELLED');e.sameUploadNewRequestId=next.id;
            if(boundary==='healthy'){
                blocker=await f.hold(queueSql);const timelyInput={...input,requestKey:randomUUID()},timely=f.track(f.controller.create(f.request,timelyInput));
                e.timelyUnlockEdge=await until(async()=>{const graph=await f.graph();return graph.find(row=>row.blockers.includes(blocker.pid));},'healthy early unlock SQL edge',3000);await delay(100);await blocker.release();
                const result=await deadline(timely.promise,'healthy admission after early unlock');assert.equal(result.ok,true);assert.equal((await f.controller.create(f.request,timelyInput)).id,result.value.id);assert.equal((await f.controller.cancel(f.request,result.value.id)).state,'CANCELLED');
            }
        }
        e.sourceAfter=await upload.inspect();assert.deepEqual(e.sourceAfter,e.sourceBefore);
        if(targetId){const after={head:(await f.pool.query('SELECT * FROM ai_plugins WHERE id=$1',[targetId])).rows,versions:(await f.pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[targetId])).rows,origins:(await f.pool.query('SELECT * FROM asset_source_receipts WHERE native_id=$1 ORDER BY repository,external_id',[targetId])).rows};assert.deepEqual(after,targetBefore);e.targetUnchanged=true;}
        if(f.service.lease===f.raw){e.sessionAfter=await sqlGuc(f.raw);assert.deepEqual(e.sessionAfter,e.sessionBefore);}
        else if(f.service.lease){e.recoveredSession=await sqlGuc(f.service.lease);assert.equal(e.recoveredSession.lock_timeout,'0');assert.equal(e.recoveredSession.statement_timeout,'0');}
        e.queueContinues=await f.runQueue(boundary==='fence-row'&&phase==='candidate'?{...input,requestKey:randomUUID()}:undefined);
        assert.equal(e.queueContinues.state,'SUCCEEDED');e.sql=f.traces;e.ok=!e.expectedRed;
    }catch(error){e.failure=failure(error);}
    finally{
        if(blocker)try{await blocker.release();}catch(error){receipt.cleanupErrors.push({label,resource:'blocker',...failure(error)});}
        if(f){e.sql=f.traces;const clean=await f.close();e.cleanup=clean;if(clean.errors.length||clean.fixtureErrors.length||!clean.ownDatabaseDropped||!clean.originalDatabasesPreserved)receipt.cleanupErrors.push({label,resource:'case cleanup',...clean});}
        receipt.cases.push(e);
    }
}

try{
    for(const boundary of ['upload-row','update-asset','update-graph','queue','fence-row'])await one(boundary);
    await one('healthy');await one('queue',{name:'lock',lock:'100',statement:'0',code:'55P03'});await one('queue',{name:'statement',lock:'0',statement:'200',code:'57014'});
}catch(error){receipt.initializationFailure=failure(error);}
finally{
    try{receipt.finalInputHashes=await inputHashes();assert.deepEqual(receipt.finalInputHashes,initial);}catch(error){receipt.cleanupErrors.push({resource:'source binding',...failure(error)});}
    const blocked=receipt.cases.filter(item=>!item.control),controls=receipt.cases.filter(item=>item.control);
    receipt.causalRed=phase==='baseline'&&blocked.length===5&&blocked.every(item=>item.expectedRed&&!item.failure&&item.pendingMs>=8000&&item.edge.pid!==item.blockerPid&&item.edge.blockers.includes(item.blockerPid)&&item.queueContinues?.state==='SUCCEEDED')&&controls.length===3&&controls.every(item=>item.ok)&&!receipt.cleanupErrors.length;
    receipt.ok=receipt.cases.length===8&&receipt.cases.every(item=>item.ok)&&!receipt.initializationFailure&&!receipt.cleanupErrors.length;receipt.finishedAt=new Date().toISOString();
    const file=path.join(directory,'receipt.json');await writeFile(file,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify({phase,receipt:file,sha256:sha(await readFile(file)),ok:receipt.ok,causalRed:receipt.causalRed,cases:receipt.cases.map(({label,ok,expectedRed,failure})=>({label,ok,expectedRed,failure})),cleanupErrors:receipt.cleanupErrors})+'\n');process.exitCode=receipt.ok?0:1;
}
