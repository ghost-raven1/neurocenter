import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {after,before,describe,it} from 'node:test';
import {startSystemRoleChatRuntime} from './system-role-chat-runtime.fixture.mjs';

const connection=process.env.SYSTEM_ROLE_CHAT_TEST_ADMIN_URL;
const chatRoot='/api/system-role-chats',main='main@service-runtime.test';
const terminal=new Set(['succeeded','failed','cancelled','interrupted']);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const deadline=async(promise,message)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),12000);})]);}
    finally{clearTimeout(timer);}
};
const json=(res,body)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));};

/** The only model peer is the fixture's guarded loopback origin; gates control physical dispatch and socket closure. */
function syntheticProvider(){
    const key='owned-service-inference-'+randomBytes(24).toString('hex');
    const provider={key,probes:[],calls:[],errors:[],gates:new Map()};
    provider.arm=model=>{
        assert.equal(provider.gates.has(model),false);
        const gate={entered:deferred(),release:deferred(),closed:deferred(),summary:'Проверенный ответ '+randomUUID()};
        provider.gates.set(model,gate);return gate;
    };
    provider.handle=async(req,res)=>{
        try{
            assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
            assert.equal(req.headers.authorization==='Bearer '+key,true,'The actual stored credential was not sent to the owned peer');
            let raw='';for await(const chunk of req){raw+=chunk;assert.ok(Buffer.byteLength(raw)<=131072);}
            const body=JSON.parse(raw);assert.equal(body.stream,false);assert.equal(typeof body.model,'string');
            const isProbe=body.messages.length===1&&body.messages[0].role==='user'&&body.messages[0].content==='Reply with the word OK.';
            const envelope=content=>({model:body.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],
                usage:{prompt_tokens:4,completion_tokens:7,total_tokens:11}});
            if(isProbe){provider.probes.push({model:body.model});json(res,envelope('OK'));return;}
            const gate=provider.gates.get(body.model);assert.ok(gate,'A new physical request has no explicit provider gate');
            const call={model:body.model,stream:body.stream,aborted:false};provider.calls.push(call);
            // IncomingMessage.close also fires on an ordinarily consumed request body. ServerResponse.close proves the response transport closed.
            res.once('close',()=>{call.aborted=!res.writableFinished;gate.closed.resolve({aborted:call.aborted});});
            gate.entered.resolve(call);
            const released=await Promise.race([gate.release.promise.then(()=>true),gate.closed.promise.then(()=>false)]);
            if(!released||res.destroyed)return;
            json(res,envelope(JSON.stringify({kind:'diagnosis',summary:gate.summary,findings:[],nextSteps:[],changes:[]})));
        }catch(error){provider.errors.push(error?.message??'Synthetic provider failure');throw error;}
    };
    return provider;
}

/** Real AppModule, SQL, background role worker, AES connection, usage and physical API admission; only the remote model is synthetic. */
describe('Service-chat inference through the canonical Catalog runtime',{skip:!connection,concurrency:false,timeout:110000},()=>{
    let f,provider;
    const asMain=(route,options={})=>f.request(main,route,{...options,role:'Главный админ'});
    const read=turn=>f.request('owner',chatRoot+'/'+turn.dialogId+'/requests/'+turn.body.input.requestId);
    const send=(turn,body=turn.body,status=201)=>f.request('owner',chatRoot+'/'+turn.dialogId+'/turns',{method:'POST',status,body});
    const matchingCalls=model=>provider.calls.filter(call=>call.model===model.model);
    const count=async(sql,args=[])=>(await f.pool.query(sql,args)).rows;

    async function observe(work,predicate,message){
        const until=performance.now()+12000;let result;
        // Poll authoritative HTTP/SQL state after an explicit provider event; no timed sleeps control the event ordering.
        while(performance.now()<until){result=await work();if(predicate(result))return result;await setImmediate();}
        assert.fail(message);
    }
    const settled=turn=>observe(()=>read(turn),value=>terminal.has(value.run.state),'The accepted role turn did not reach a durable terminal state');

    async function model(){
        let card=await asMain('/api/models',{method:'POST',status:201,body:{requestKey:randomUUID(),name:'Owned service-chat model '+randomUUID(),
            runtime:'remote-openai',capability:'chat',model:'qa-service-inference-'+randomUUID(),modelVersion:'1'}});
        const origin=new URL(process.env.MODEL_RUNTIME_URL);assert.equal(origin.hostname,'127.0.0.1');assert.ok(Number(origin.port)>0);
        const saved=await asMain('/api/models/'+card.id+'/connection',{method:'PUT',body:{expectedRevision:0,expectedModelRevision:card.revision,
            baseUrl:origin.origin+'/v1',requestDimensions:false,credential:'stored',apiKey:provider.key,options:{maxOutputTokens:128}}});
        assert.equal(saved.hasKey,true);assert.equal(JSON.stringify(saved).includes(provider.key),false,'The write-only provider key leaked into the connection DTO');
        const stored=await count('SELECT credential FROM model_remote_connections WHERE model_id=$1',[card.id]);
        assert.equal(stored.length,1);assert.equal(stored[0].credential.algorithm,'A256GCM');
        assert.equal(JSON.stringify(stored).includes(provider.key),false,'The provider key was stored in plaintext');
        await asMain('/api/models/'+card.id+'/rate-limit',{method:'PUT',body:{expectedRevision:0,requests:1000,windowMs:1000,enabled:true}});
        card=await asMain('/api/models/'+card.id);
        await asMain('/api/models/'+card.id+'/hosting',{method:'POST',status:201,body:{action:'check',expectedRevision:card.revision}});
        const hosting=await observe(()=>asMain('/api/models/'+card.id+'/hosting'),value=>value.state!=='busy','The real model hosting probe did not finish');
        assert.equal(hosting.state,'ready');card=await asMain('/api/models/'+card.id);
        assert.match(card.modelPin,/^[a-f0-9]{64}$/);assert.ok(card.verificationSha256);
        await asMain('/api/projects/'+f.project+'/models',{method:'POST',status:201,body:{modelId:card.id}});
        assert.equal(provider.probes.filter(call=>call.model===card.model).length,1);
        assert.equal((await count('SELECT id FROM model_api_dispatch_slots WHERE model_id=$1',[card.id])).length,1);
        return card;
    }

    async function turn(card){
        const dialog=await f.request('owner',chatRoot,{method:'POST',status:201,body:{id:randomUUID(),title:'Проверка сервисного агента',projectId:f.project}});
        const preview=await f.request('owner',chatRoot+'/'+dialog.id+'/prepare',{method:'POST',status:201,body:{agentId:'agent-ai-admin',includeContext:false,
            selection:{projectId:f.project,instruction:'Объясни состояние выбранного контекста без изменения настроек.',diagnostics:[],targets:[]}}});
        return {dialogId:dialog.id,body:{agentId:'agent-ai-admin',input:{...preview.selection,requestId:randomUUID(),modelId:card.id,
            expectedModelPin:card.modelPin,expectedDefinitionPin:preview.prepared.definitionPin,consentDigest:preview.prepared.consentDigest}}};
    }

    async function accounting(current,card,status){
        const usage=await observe(()=>count('SELECT * FROM model_usage_calls WHERE operation_id=$1',[current.run.id]),
            rows=>rows.length===1&&rows[0].status!=='pending','The actual usage receipt did not finish');
        const row=usage[0];assert.equal(row.purpose,'agent');assert.equal(row.agent_id,'agent-ai-admin');assert.equal(row.project_id,f.project);
        assert.equal(row.actor_email,f.actors.owner);assert.equal(row.model_id,card.id);assert.equal(row.endpoint,'chat');assert.equal(row.status,status);
        assert.equal(Number(row.dispatch_count),1);assert.ok(row.dispatched_at);assert.equal(current.run.callsStarted,1);
        assert.equal(matchingCalls(card).length,1);
        assert.equal((await count('SELECT id FROM model_api_dispatch_slots WHERE model_id=$1',[card.id])).length,2,'Probe and accepted agent call must each own exactly one physical admission slot');
        const operation=await count('SELECT state,percent FROM operations WHERE operation_id=$1',[current.run.operationId]);
        assert.equal(operation.length,1);assert.equal(Number(operation[0].percent),100);
        assert.equal(operation[0].state,status==='success'?'SUCCEEDED':status==='cancelled'?'CANCELLED':'FAILED');
        return row;
    }

    async function exactlyOneIntent(turn,current){
        assert.equal((await count('SELECT id FROM system_role_dialog_intents WHERE request_id=$1',[turn.body.input.requestId])).length,1);
        assert.equal((await count('SELECT id FROM system_role_runs WHERE request_id=$1',[turn.body.input.requestId])).length,1);
        assert.equal((await read(turn)).run.id,current.run.id);
        assert.equal((await send(turn)).run.id,current.run.id);
    }

    before(async()=>{provider=syntheticProvider();f=await startSystemRoleChatRuntime(connection,{syntheticChatCompletions:provider.handle});});
    after(async()=>{for(const gate of provider?.gates.values()??[])gate.release.resolve();await f?.close();});

    it('finishes one accepted turn despite status-event HTTP503 and recovers/replays the same durable receipt without another dispatch',async()=>{
        const card=await model(),intent=await turn(card),gate=provider.arm(card.model);
        const eventsBefore=f.state.dependencyCalls.filter(call=>call.path==='/internal/events').length;
        f.state.eventStatus=503;
        try{
            const accepted=await send(intent);await deadline(gate.entered.promise,'The owned provider did not receive the accepted turn');
            assert.equal(accepted.id,intent.body.input.requestId);assert.equal(accepted.run.result,null);
            assert.equal((await read(intent)).run.id,accepted.run.id);assert.equal((await send(intent)).run.id,accepted.run.id);
            gate.release.resolve();await deadline(gate.closed.promise,'The synthetic provider response did not close');
            const done=await settled(intent);assert.equal(done.run.state,'succeeded');assert.equal(done.run.result.summary,gate.summary);
            await exactlyOneIntent(intent,done);
            const row=await accounting(done,card,'success');assert.equal(Number(row.input_tokens),4);assert.equal(Number(row.output_tokens),7);
            assert.ok(f.state.dependencyCalls.filter(call=>call.path==='/internal/events').length>eventsBefore,'The status-event outage was not exercised');
            assert.equal((await f.request('owner',chatRoot+'/'+intent.dialogId)).turns[0].run.result.summary,gate.summary);
        }finally{f.state.eventStatus=200;gate.release.resolve();}
    });

    it('cancels an accepted running turn, physically closes the provider response and never attaches its late answer',async()=>{
        const card=await model(),intent=await turn(card),gate=provider.arm(card.model);
        await send(intent);await deadline(gate.entered.promise,'The provider did not enter the cancellation barrier');
        const current=await read(intent);
        const cancelled=await f.request('owner',chatRoot+'/'+intent.dialogId+'/turns/'+intent.body.input.requestId+'/cancel',{method:'POST',status:201,
            body:{expectedRevision:current.run.revision,requestId:randomUUID()}});
        assert.equal(cancelled.run.state,'cancelled');assert.equal(cancelled.cancelRequested,true);
        assert.equal((await deadline(gate.closed.promise,'Cancellation did not physically abort the remote response')).aborted,true);
        gate.release.resolve();const done=await settled(intent);assert.equal(done.run.result,null);
        await exactlyOneIntent(intent,done);await accounting(done,card,'cancelled');
        assert.equal(JSON.stringify(await f.request('owner',chatRoot+'/'+intent.dialogId)).includes(gate.summary),false);
    });

    for(const flag of ['system_role_chat','system_ai_admin'])it('retains the accepted paid result after '+flag+' is disabled, while refusing a new turn',async()=>{
        const card=await model(),intent=await turn(card),gate=provider.arm(card.model);
        await send(intent);await deadline(gate.entered.promise,'The provider did not enter the feature-change barrier');
        f.state.flags[flag]=false;
        try{
            await send(intent,{...intent.body,input:{...intent.body.input,requestId:randomUUID()}},403);
            assert.equal((await send(intent)).run.id,(await read(intent)).run.id);
            gate.release.resolve();await deadline(gate.closed.promise,'The accepted paid response did not close');
            const done=await settled(intent);assert.equal(done.run.state,'succeeded');assert.equal(done.run.result.summary,gate.summary);
            await exactlyOneIntent(intent,done);await accounting(done,card,'success');
        }finally{f.state.flags[flag]=true;gate.release.resolve();}
    });

    it('denies the completed provider response after the actual stored connection is revoked and does not repeat paid inference',async()=>{
        const card=await model(),intent=await turn(card),gate=provider.arm(card.model);
        await send(intent);await deadline(gate.entered.promise,'The provider did not enter the connection-revocation barrier');
        const connection=await asMain('/api/models/'+card.id+'/connection'),fresh=await asMain('/api/models/'+card.id);
        await asMain('/api/models/'+card.id+'/connection',{method:'DELETE',body:{expectedRevision:connection.revision,expectedModelRevision:fresh.revision}});
        gate.release.resolve();await deadline(gate.closed.promise,'The revoked provider response did not close');
        const done=await settled(intent);assert.equal(done.run.state,'failed');assert.equal(done.run.result,null);
        await exactlyOneIntent(intent,done);await accounting(done,card,'error');
        assert.equal(JSON.stringify(await f.request('owner',chatRoot+'/'+intent.dialogId)).includes(gate.summary),false,'A stale provider answer leaked into durable chat history');
    });

    it('keeps unrelated bridge and MCP ledgers empty and closes the canonical runtime without leaked SQL clients',async()=>{
        const counts=await f.ledgerCounts();
        assert.equal(counts.system_role_runs,5);assert.equal(counts.system_role_dialog_intents,5);
        assert.equal(counts.model_usage_calls,10);assert.equal(counts.model_hosting_jobs,5);
        assert.equal((await count('SELECT id FROM model_api_dispatch_slots')).length,10);
        for(const table of ['system_role_mcp_sessions','system_role_mcp_calls','device_model_calls','bridge_jobs','tool_build_jobs'])assert.equal(counts[table],0,table);
        assert.equal(provider.probes.length,5);assert.equal(provider.calls.length,5);assert.deepEqual(provider.errors,[]);
        assert.equal(f.state.unknownDependencies,0);assert.equal(f.state.blockedFetches,0);assert.equal(f.state.blockedPools,0);
        const cleanup=await f.close();assert.equal(cleanup.applicationClosed,true);assert.equal(cleanup.clientsAfterApplicationClose,0);
        assert.equal(cleanup.databaseDropped,true);assert.deepEqual(cleanup.failures,[]);
    });
});
