import http from 'node:http';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {RemoteModelClient} from '../src/models/remote-model-client';
import {remoteModelOptions,assertRemoteModelOptions} from '../src/models/remote-model-options';
import {remoteVerificationDigest} from '../src/models/remote-model-validation';
import type {IModel} from '../src/models/model.types';
import type {IRemoteModelConnection} from '../src/models/remote-model.types';
import {RemoteConnectionRepository} from '../src/models/remote-connection.repository';
import type {Pool} from 'pg';

const model:IModel={id:'fixture-adapter',name:'Fixture',description:'',runtime:'remote-openai',model:'exact-model',modelVersion:'exact-v1',capability:'chat',dimension:null,
    source:'custom',manifestSha256:null,verificationSha256:null,revision:1,createdAt:'',updatedAt:''};
const messages=[{role:'user',content:'Fixture input'}];
const response=()=>({object:'response',model:model.model,status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:12,output_tokens:7}});

describe('Private adapter parameters preserve semantics',()=>{
    it('Saves complete private JSON but emits no private values or names into the shared audit',async()=>{
        const previous={model_id:model.id,revision:1,base_url:'https://fixture.example/v1',request_dimensions:false,credential_kind:'none',credential:null,credential_env:null,
            options:{store:false,apiFormat:'responses',providerParameters:{privateOldName:'fixture-old-private'}},timeout_ms:90000,semantic_sha:null,verified_at:null,failure_message:null,revoked_at:null};
        const {id,name,revision,createdAt,updatedAt,...descriptor}=model;
        let saved:typeof previous|undefined,audit:unknown[]|undefined;
        const db={release:()=>undefined,query:async(sql:string,values:unknown[]=[])=>{
            if(sql.startsWith('SELECT * FROM model_catalog'))return {rows:[{id,name,revision,created_at:createdAt,updated_at:updatedAt,descriptor}]};
            if(sql.startsWith('SELECT * FROM model_remote_connections'))return {rows:[previous]};
            if(sql.startsWith('INSERT INTO model_remote_connections')){saved={...previous,revision:2,options:JSON.parse(values[7] as string)};return {rows:[saved]};}
            if(sql.startsWith('INSERT INTO security_events'))audit=values;
            return {rows:[]};
        }};
        const parameters={privateNewName:{enabled:false,value:null,note:'fixture-new-private'}};
        const result=await new RemoteConnectionRepository({connect:async()=>db} as unknown as Pool,{}).save(model.id,{expectedModelRevision:1,expectedRevision:1,
            baseUrl:previous.base_url,requestDimensions:false,credential:'none',options:{apiFormat:'responses',store:false,providerParameters:parameters}},'fixture',async()=>undefined);
        expect(saved?.options.providerParameters).toEqual(parameters);expect(result.options.providerParameters).toEqual(parameters);
        expect(JSON.stringify(audit)).not.toMatch(/privateOldName|privateNewName|fixture-old-private|fixture-new-private/);
        expect(JSON.parse(audit![4] as string)).toMatchObject({options:{apiFormat:'responses',store:false},providerParameterCount:1});
        expect(JSON.parse(audit![5] as string)).toMatchObject({options:{apiFormat:'responses',store:false},providerParameterCount:1});
    });
    it('Includes every nested value in the semantic pin while ignoring object insertion order',()=>{
        const connection={modelId:model.id,revision:1,baseUrl:'https://fixture.example/v1',requestDimensions:false};
        const first=remoteModelOptions({apiFormat:'responses',store:false,providerParameters:{custom:{z:null,a:false},seed:42}});
        const second=remoteModelOptions({store:false,apiFormat:'responses',providerParameters:{seed:42,custom:{a:false,z:null}}});
        const pin=remoteVerificationDigest(model,{...connection,options:first},null);
        expect(remoteVerificationDigest(model,{...connection,options:second},null)).toBe(pin);
        expect(remoteVerificationDigest(model,{...connection,options:{...first,providerParameters:{custom:{a:true,z:null},seed:42}}},null)).not.toBe(pin);
        expect(remoteVerificationDigest(model,{...connection,options:{apiFormat:'chat-completions',providerParameters:first.providerParameters}},null)).not.toBe(pin);
    });
    it('Validates explicit protocol/settings and leaves arbitrary private JSON intact',()=>{
        const parameters=Object.fromEntries(Array.from({length:100},(_,i)=>['custom'+i,{flag:false,value:null}]));
        expect(remoteModelOptions({providerParameters:parameters})).toEqual({providerParameters:parameters});
        expect(()=>assertRemoteModelOptions(model,{reasoningEffort:'high'})).toThrow('Responses');
        expect(()=>assertRemoteModelOptions(model,{apiFormat:'responses',tokenLimitParameter:'max_tokens'})).toThrow('max_output_tokens');
        expect(()=>assertRemoteModelOptions({...model,runtime:'remote-ollama'},{apiFormat:'responses'})).toThrow('OpenAI');
        for(const options of [{store:'false'},{reasoningEffort:'unbounded'},{providerParameters:{model:'other'}},{providerParameters:{headers:{authorization:'fixture-private'}}}])expect(()=>remoteModelOptions(options)).toThrow();
    });
});

describe('Actual owned HTTP adapter boundaries',()=>{
    let server:http.Server,connection:IRemoteModelConnection,answer:Record<string,unknown>;
    const received:Array<{url:string|undefined;body:Record<string,unknown>;authorization:string|undefined}>=[];
    beforeEach(async()=>{
        received.length=0;answer=response();
        server=http.createServer(async(req,res)=>{
            const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
            received.push({url:req.url,body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization});
            res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));
        });
        await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        connection={modelId:model.id,revision:1,baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,requestDimensions:false,apiKey:'private-fixture-key',
            options:{apiFormat:'responses',reasoningEffort:'high',store:false,maxOutputTokens:2048,providerParameters:{custom:{enabled:false,value:null},seed:42}}};
    });
    afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
    it('Responses uses the exact model, protocol, option values and token accounting without fallback',async()=>{
        const result=await new RemoteModelClient().infer(model,connection,'chat',{messages});
        expect(received).toEqual([{url:'/v1/responses',authorization:'Bearer private-fixture-key',body:{model:model.model,input:[{role:'user',content:[{type:'input_text',text:'Fixture input'}]}],stream:false,
            reasoning:{effort:'high'},store:false,max_output_tokens:2048,custom:{enabled:false,value:null},seed:42}}]);
        expect(result).toMatchObject({model:model.model,done:true,done_reason:'stop',message:{content:'OK'},prompt_eval_count:12,eval_count:7,usage_reported:true});
    });
    it('Per-request generation budget does not override administrator transport/protected/custom settings',async()=>{
        await new RemoteModelClient().infer(model,connection,'chat',{messages,options:{num_predict:32,apiFormat:'chat-completions',store:true,reasoningEffort:'low',providerParameters:{seed:99}}});
        expect(received[0]!.url).toBe('/v1/responses');expect(received[0]!.body).toMatchObject({max_output_tokens:32,store:false,reasoning:{effort:'high'},seed:42});
    });
    it('Chat Completions receives any declared body parameters without changing its existing defaults',async()=>{
        answer={model:model.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'OK'}}]};
        connection.options={providerParameters:{reasoning_effort:'low',seed:0,custom:{enabled:false,value:null}}};
        await new RemoteModelClient().infer(model,connection,'chat',{messages});
        expect(received[0]!.url).toBe('/v1/chat/completions');expect(received[0]!.body).toEqual({model:model.model,messages,stream:false,reasoning_effort:'low',seed:0,custom:{enabled:false,value:null}});
    });
    it('Ollama parameters stay at its declared options path',async()=>{
        answer={model:model.model,done:true,done_reason:'stop',message:{content:'OK'}};connection.options={temperature:0,providerParameters:{repeat_penalty:1.1,seed:0,custom:{enabled:false,value:null}}};
        await new RemoteModelClient().infer({...model,runtime:'remote-ollama'},connection,'chat',{messages});
        expect(received[0]!.url).toBe('/v1/api/chat');expect(received[0]!.body).toEqual({model:model.model,messages,stream:false,think:false,options:{temperature:0,repeat_penalty:1.1,seed:0,custom:{enabled:false,value:null}}});
    });
    it('Conflicting form/JSON values and protected paths fail before any HTTP request',async()=>{
        for(const options of [{temperature:0,providerParameters:{temperature:1}},{providerParameters:{model:'other'}},{providerParameters:{messages:[]}},{providerParameters:{tools:[]}}]){
            await expect(new RemoteModelClient().infer(model,{...connection,options},'chat',{messages})).rejects.toThrow();
        }
        expect(received).toHaveLength(0);
    });
    it('Maps vision text/image and assistant history to the Responses message schema',async()=>{
        const image=Buffer.from('fixture jpeg').toString('base64');
        await new RemoteModelClient().infer({...model,capability:'vision'},connection,'chat',{messages:[{role:'system',content:'Instruction'},{role:'assistant',content:'Prior'},{role:'user',content:'Image',images:[image]}]});
        expect(received[0]!.body.input).toEqual([{role:'system',content:[{type:'input_text',text:'Instruction'}]},{role:'assistant',content:[{type:'output_text',text:'Prior'}]},
            {role:'user',content:[{type:'input_text',text:'Image'},{type:'input_image',image_url:'data:image/jpeg;base64,'+image,detail:'auto'}]}]);
    });
    it('Only explicit max_output_tokens incompleteness becomes a length result',async()=>{
        answer={...response(),status:'incomplete',incomplete_details:{reason:'max_output_tokens'}};
        expect(await new RemoteModelClient().infer(model,connection,'chat',{messages})).toMatchObject({done_reason:'length',message:{content:'OK'}});
        expect(received).toHaveLength(1);
    });
    it.each(['model','status','tool','refusal','empty','incomplete'])('Rejects incompatible Responses output %s without a paid fallback request',async mode=>{
        if(mode==='model')answer.model='different-model';
        if(mode==='status')answer.status='in_progress';
        if(mode==='tool')answer.output=[{type:'function_call',name:'not-enabled',arguments:'{}'}];
        if(mode==='refusal')answer.output=[{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'no'}]}];
        if(mode==='empty')answer.output=[{type:'reasoning',summary:[]}];
        if(mode==='incomplete'){answer.status='incomplete';answer.incomplete_details={reason:'content_filter'};}
        await expect(new RemoteModelClient().infer(model,connection,'chat',{messages})).rejects.toMatchObject({kind:'response'});expect(received).toHaveLength(1);
    });
});
