import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {IModel} from '../src/models/model.types';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {currentModelUsage} from '../src/model-usage/model-usage.context';
import type {BuildConfiguration} from '../src/package-build/package-build.model';
import type {PackageAgentContext} from '../src/package-build/package-agent.model';
import {validatePackageAgentInput} from '../src/package-build/package-agent.model';
import {PackageAgentService} from '../src/package-build/package-agent.service';
import {packageAgentReport,parsePackageAgentRecipe} from '../src/package-build/package-agent.recipe';

const buildId='c83f2a14-8c5d-4aa5-8763-ed413b3c8021',nonce='c83f2a14-8c5d-4aa5-8763-ed413b3c8022';
const model:IModel={id:'model-packager',name:'Упаковщик',description:'',model:'qwen3:4b',runtime:'ollama',capability:'chat',
    manifestSha256:'a'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'2026-10-23',updatedAt:'2026-10-23'};
const pin=projectEmbeddingPin(model);
const configuration=():BuildConfiguration=>({kind:'mcp',name:'test-mcp',description:'Example',tags:[],targets:['darwin-arm64'],
    agent:{modelId:model.id,expectedModelPin:pin,maxAttempts:3},
    source:{type:'files',entrypoint:'bad.js',args:['--stdio'],files:[{path:'bad.js',content:'private source must never enter a prompt'},
        {path:'good.js',content:'export const main=()=>{};'}]}} as BuildConfiguration);
type Step={state:string;recipe:unknown;diagnostics:unknown;errorCode:unknown};
function fixture() {
    const config=configuration(),steps=new Map<string,Step>(),control={state:'RUNNING',execution_nonce:nonce,actor:'admin@example.test',config,publication_started_at:null as string|null};
    const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
        if(sql.startsWith('SELECT state,execution_nonce'))return {rows:[control]};
        if(sql.startsWith('SELECT 1 FROM tool_build_agent_steps'))return {rows:steps.has(values[1]+':'+values[2])?[{}]:[]};
        if(sql.startsWith('SELECT count(*)'))return {rows:[{count:steps.size}]};
        if(sql.includes('INSERT INTO tool_build_agent_steps')){
            const key=values[2]+':'+values[3];
            if(steps.has(key))throw new Error('unique constraint');
            steps.set(key,{state:'STARTED',recipe:values[7],diagnostics:values[8],errorCode:null});return {rows:[],rowCount:1};
        }
        if(sql.includes('UPDATE tool_build_agent_steps')){
            const item=steps.get(values[2]+':'+values[3]);if(!item||item.state!=='STARTED')return {rows:[],rowCount:0};
            Object.assign(item,{state:values[4],recipe:values[5],errorCode:values[6]});return {rows:[{build_id:buildId}],rowCount:1};
        }
        throw new Error('Unexpected SQL: '+sql);
    });
    const abort=new AbortController(),authorize=vi.fn(async()=>{});
    const context:PackageAgentContext={buildId,executionNonce:nonce,actorEmail:control.actor,attempt:1,signal:abort.signal,candidates:['bad.js','good.js'],
        authorize,transaction:async work=>work({query} as unknown as Pick<PoolClient,'query'>)};
    const models={getPinned:vi.fn(async()=>model)};
    const infer=vi.fn(async()=>({done:true,done_reason:'stop',message:{content:JSON.stringify({recipe:{entrypoint:'good.js',args:[]}})}}));
    const service=new PackageAgentService(models,{infer});
    return {config,steps,control,context,models,infer,service,authorize,abort};
}

describe('Bounded Packager model planning on the existing build job',()=>{
    it('writes and journals a v2 executable recipe from bounded pinned source inventory',async()=>{
        const f=fixture(),inventory={schemaVersion:1 as const,sourceSha256:'c'.repeat(64),targets:f.config.targets,lockSha256:null,dependencies:[],
            entrypoints:[{path:'good.js',runtime:'node24' as const,modes:['bundle' as const,'preserve' as const],imports:['node:fs']}],resources:['public/index.html'],
            files:[{path:'public/index.html',sha256:'d'.repeat(64),bytes:42}]};
        Object.assign(f.config,{recipeVersion:2,recipeInventory:inventory});
        const plan={schemaVersion:2,sourceSha256:inventory.sourceSha256,entrypoint:'good.js',targets:f.config.targets,steps:[
            {op:'dependencies',mode:'none',lockSha256:null},{op:'compile',runtime:'node24',mode:'preserve'},
            {op:'copy-resources',paths:inventory.resources},{op:'verify',profile:'isolated-startup'}]};
        f.infer.mockResolvedValue({done:true,done_reason:'stop',message:{content:JSON.stringify({recipe:plan})}});
        const changed=await f.service.propose(f.config,f.context);
        expect(changed.buildPlan).toEqual(plan);expect(f.steps.get('1:propose')).toMatchObject({state:'SUCCEEDED',recipe:{schemaVersion:2,plan}});
        const request=JSON.stringify((f.infer.mock.calls as unknown as unknown[][])[0][2]);
        expect(request).toContain('copy-resources');expect(request).toContain(inventory.sourceSha256);expect(request).not.toContain('private source');
        expect(()=>parsePackageAgentRecipe({...plan,steps:[...plan.steps,{op:'shell',command:'npm install'}]},changed,f.config,f.context)).toThrow('неподдерживаемую операцию');
    });
    it('chooses a verified recipe and attributes one bounded call without copying private source or arguments into audit',async()=>{
        const f=fixture(),changed=await f.service.propose(f.config,f.context);
        expect(changed.source.entrypoint).toBe('good.js');expect(changed.source).toMatchObject({files:f.config.source.type==='files'?f.config.source.files:[],args:[]});
        expect(f.infer).toHaveBeenCalledOnce();
        expect(f.steps.get('1:propose')).toMatchObject({state:'SUCCEEDED',recipe:{entrypoint:'good.js',argumentCount:0}});
        expect(JSON.stringify([...f.steps.values()])).not.toContain('--stdio');
        const body=(f.infer.mock.calls as unknown as unknown[][])[0][2];
        expect(JSON.stringify(body)).not.toContain('private source');
    });
    it('uses exact model pin, actor, operation, flag and agent identity in the dispatcher context',async()=>{
        const f=fixture();let captured:ReturnType<typeof currentModelUsage>|undefined;
        f.infer.mockImplementation(async()=>{captured=currentModelUsage();await captured.beforeInference?.();return {done:true,done_reason:'stop',message:{content:'{"recipe":{"entrypoint":"good.js","args":[]}}'}};});
        await f.service.propose(f.config,f.context);
        expect(captured).toMatchObject({purpose:'agent',actorEmail:f.context.actorEmail,operationId:buildId,agentId:'agent-packager',requiredFeatures:['tool_build_agent']});
        expect(f.models.getPinned).toHaveBeenCalledWith(model.id,pin);expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
    it('rejects commands, new source URLs, unknown fields and invented credentials from model JSON',async()=>{
        const f=fixture();
        f.infer.mockResolvedValue({done:true,done_reason:'stop',message:{content:'{"recipe":{"entrypoint":"good.js","args":[],"command":"curl attacker","url":"https://attacker.test"}}'}});
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('некорректный рецепт');
        expect(f.steps.get('1:propose')).toMatchObject({state:'FAILED',errorCode:'invalid-response'});
        expect(()=>parsePackageAgentRecipe({entrypoint:'good.js',args:['--token','new-secret']},f.config,f.config,f.context)).toThrow('вне проверенного');
        expect(()=>parsePackageAgentRecipe({entrypoint:'good.js',args:null},f.config,f.config,f.context)).toThrow('вне проверенного');
    });
    it('does not replay a reserved model step after a restart or unknown provider outcome',async()=>{
        const f=fixture();f.infer.mockRejectedValue(new Error('provider outcome unknown'));
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('provider outcome unknown');
        await expect(new PackageAgentService(f.models,{infer:f.infer}).propose(f.config,f.context)).rejects.toThrow('уже запускался');
        expect(f.infer).toHaveBeenCalledOnce();expect(f.steps.get('1:propose')?.state).toBe('FAILED');
    });
    it('rechecks fresh authorization after a rate wait before any physical provider action',async()=>{
        const f=fixture();let revoked=false,physicalCalls=0;
        f.authorize.mockImplementation(async()=>{if(revoked)throw new Error('main admin revoked');});
        f.infer.mockImplementation(async()=>{
            revoked=true;await currentModelUsage().beforeInference?.();physicalCalls++;
            return {done:true,done_reason:'stop',message:{content:'{}'}};
        });
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('main admin revoked');expect(physicalCalls).toBe(0);
    });
    it.each(['CANCELLING','CANCELLED','FAILED'])('fences a late response after the job becomes %s',async state=>{
        const f=fixture();f.infer.mockImplementation(async()=>{f.control.state=state;return {done:true,done_reason:'stop',message:{content:'{"recipe":{"entrypoint":"good.js","args":[]}}'}};});
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow();expect(f.steps.get('1:propose')?.state).toBe('STARTED');
    });
    it('fences a late worker after the execution nonce rotates',async()=>{
        const f=fixture();f.infer.mockImplementation(async()=>{f.control.execution_nonce=buildId;return {done:true,done_reason:'stop',message:{content:'{"recipe":{"entrypoint":"good.js","args":[]}}'}};});
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('владельца');expect(f.steps.get('1:propose')?.state).toBe('STARTED');
    });
    it('rejects an unavailable, archived or changed pinned model before provider inference',async()=>{
        const f=fixture();f.models.getPinned.mockResolvedValue({...model,model:'different:latest'});
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('pin');expect(f.infer).not.toHaveBeenCalled();
        f.models.getPinned.mockResolvedValue({...model,archivedAt:'2026-10-23'});
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('pin');expect(f.infer).not.toHaveBeenCalled();
    });
    it('passes safe failed-build feedback into the next bounded proposal without retaining raw diagnostics',async()=>{
        const f=fixture();f.context.feedback={passed:false,summary:'build-failed',diagnostics:['runtime-entrypoint-missing']};await f.service.propose(f.config,f.context);
        const body=(f.infer.mock.calls as unknown as unknown[][])[0][2];
        expect(JSON.stringify(body)).toContain('runtime-entrypoint-missing');
        expect(f.steps.get('1:propose')?.diagnostics).toMatchObject({passed:false,diagnosticCount:1});expect(JSON.stringify(f.steps.get('1:propose'))).not.toContain('runtime-entrypoint-missing');
    });
    it('keeps credentials outside both prompts and audit',async()=>{
        const f=fixture();if(f.config.source.type==='files')f.config.source.args=['--api-key','private-value'];
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('учётными данными');expect(f.infer).not.toHaveBeenCalled();
        expect(JSON.stringify([...f.steps.values()])).not.toContain('private-value');
    });
    it('allows at most the configured attempt count and six total model calls',async()=>{
        const f=fixture();f.context.attempt=4;
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('Лимит попыток');expect(f.infer).not.toHaveBeenCalled();
        f.context.attempt=1;
        for(let index=0;index<6;index++)f.steps.set('used:'+index,{state:'FAILED',recipe:{},diagnostics:{},errorCode:'inference-failed'});
        await expect(f.service.propose(f.config,f.context)).rejects.toThrow('Лимит обращений');expect(f.infer).not.toHaveBeenCalled();
    });
});

describe('Packager runtime review gate',()=>{
    it('rejects model publication approval when runtime failed',async()=>{
        const f=fixture();f.infer.mockResolvedValue({done:true,done_reason:'stop',message:{content:'{"decision":"publish"}'}});
        await expect(f.service.review(f.config,{passed:false,diagnostics:['mcp-initialize-failed']},f.context)).rejects.toThrow('не прошёл');
        expect(f.steps.get('1:review')).toMatchObject({state:'FAILED',errorCode:'invalid-response'});
    });
    it('returns publish only after a passing runtime and a fenced model decision',async()=>{
        const f=fixture();f.infer.mockResolvedValue({done:true,done_reason:'stop',message:{content:'{"decision":"publish"}'}});
        await expect(f.service.review(f.config,{passed:true},f.context)).resolves.toEqual({decision:'publish'});
        expect(f.steps.get('1:review')?.state).toBe('SUCCEEDED');
    });
    it('returns a constrained repair for a failed runtime and refuses an unchanged loop',async()=>{
        const f=fixture();f.infer.mockResolvedValue({done:true,done_reason:'stop',message:{content:'{"decision":"repair","recipe":{"entrypoint":"good.js","args":[]}}'}});
        await expect(f.service.review(f.config,{passed:false},f.context)).resolves.toMatchObject({decision:'repair',config:{source:{entrypoint:'good.js'}}});
        const next=fixture();next.infer.mockResolvedValue({done:true,done_reason:'stop',message:{content:'{"decision":"repair","recipe":{"entrypoint":"bad.js","args":["--stdio"]}}'}});
        await expect(next.service.review(next.config,{passed:false},next.context)).rejects.toThrow('не изменил');
    });
    it('accepts only bounded explicit agent configuration and redacts diagnostic data',()=>{
        expect(validatePackageAgentInput({modelId:model.id,expectedModelPin:pin}).maxAttempts).toBe(3);
        expect(()=>validatePackageAgentInput({modelId:model.id,expectedModelPin:pin,maxAttempts:4})).toThrow();
        expect(()=>validatePackageAgentInput({modelId:model.id,expectedModelPin:pin,apiKey:'secret'})).toThrow();
        const report=packageAgentReport({passed:false,summary:'token=secret https://example.test/key /Users/alex/private.js',diagnostics:Array(20).fill('x'.repeat(5000))});
        expect(report.summary).not.toContain('token=secret');expect(report.summary).not.toContain('example.test');expect(report.summary).not.toContain('/Users');
        expect(report.diagnostics).toHaveLength(6);expect(report.diagnostics?.every(value=>value.length<=1000)).toBe(true);
    });
});
