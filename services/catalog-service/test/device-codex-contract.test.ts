import {describe,expect,it} from 'vitest';
import {DEVICE_CODEX_PROTOCOL,normalizeDeviceCodexPayload,normalizeDeviceCodexRequest,normalizeDeviceCodexResult,deviceCodexResultDigest} from '../../shared/device-codex-inference.cjs';
import {createProjectAgentsPayload,compileProjectAgents} from '../../shared/project-agents.cjs';
import {automaticModelOptions} from '../src/models/model-runtime-options';
import {deviceCodexIdentityDigest} from '../src/models/device-codex-identity';

const id='10000000-0000-4000-8000-000000000001',sha='a'.repeat(64);
const payload={protocol:DEVICE_CODEX_PROTOCOL,callId:id,modelId:'model-local',modelPin:sha,connectionRevision:1,source:{scope:'global'},deadlineAt:'2026-10-24T00:00:00.000Z'};
describe('Local Codex protocol preserves privacy and declared capabilities',()=>{
    it('public job rejects prompt, connector package and arbitrary source fields',()=>{
        expect(normalizeDeviceCodexPayload(payload)).toEqual(payload);
        for(const extra of [{messages:[]},{connectorPackage:{}},{source:{scope:'global',path:'/private'}}])expect(()=>normalizeDeviceCodexPayload({...payload,...extra})).toThrow();
    });
    it.each([{temperature:0},{top_p:0.5},{num_predict:256},{num_ctx:8192},{store:true}])('unsupported explicit wire option never disappears: %j',options=>{
        expect(()=>normalizeDeviceCodexRequest({messages:[{role:'user',content:'test'}],options},'chat')).toThrow();
    });
    it('retains exact reasoning policy and keeps images out of text-only models',()=>{
        const request={messages:[{role:'user',content:'test'}],options:{reasoningEffort:'high',store:false}};
        expect(normalizeDeviceCodexRequest(request,'chat')).toEqual(request);
        expect(()=>normalizeDeviceCodexRequest({...request,messages:[{role:'user',content:'test',images:['AAAA']}]},'chat')).toThrow();
    });
    it('automatic planning budgets are distinct from explicit sampler overrides',()=>{
        expect(automaticModelOptions({runtime:'device-codex'},{temperature:0,num_predict:256,num_ctx:8192})).toEqual({});
        expect(()=>automaticModelOptions({runtime:'device-codex'},{num_predict:256},{temperature:0})).toThrow('не поддерживает');
        expect(automaticModelOptions({runtime:'remote-openai'},{num_predict:256},{temperature:0})).toEqual({num_predict:256,temperature:0});
    });
    it('receipt digest ignores object key order without accepting a changed response',()=>{
        const response={model:'codex',done:true,done_reason:'stop',message:{role:'assistant',content:'private'},prompt_eval_count:null,eval_count:4,usage_reported:true};
        const first={protocol:DEVICE_CODEX_PROTOCOL,callId:id,response};
        expect(normalizeDeviceCodexResult(first)).toEqual(first);
        expect(deviceCodexResultDigest({...first,response:{...response,message:{content:'private',role:'assistant'}}})).toBe(deviceCodexResultDigest(first));
        expect(deviceCodexResultDigest({...first,response:{...response,message:{role:'assistant',content:'changed'}}})).not.toBe(deviceCodexResultDigest(first));
        expect(deviceCodexIdentityDigest({source:{scope:'global'},model:'codex'})).toBe(deviceCodexIdentityDigest({model:'codex',source:{scope:'global'}}));
    });
});

describe('Catalog Codex pins compile to one exact native OpenCode source',()=>{
    const agent={id:'agent-owned',slug:'nc-owned',version:1,enabled:true,description:'Owned',prompt:'Owned prompt',mode:'all',permission:{},model:'neurocenter/model-local'};
    const requirement={kind:'catalog',agentId:agent.id,catalogModelId:'model-local',modelPin:sha,runtime:'device-codex',sourceSelector:'codexbridge/alias',runtimeModel:'codex',baseUrl:'https://chatgpt.com/backend-api/codex',options:{},capability:'chat'};
    const mapping={agentId:agent.id,provider:'codexbridge',configKey:'alias',runtime:'remote-openai',model:'codex',baseUrl:requirement.baseUrl,options:{},capability:'chat'};
    const source=()=>createProjectAgentsPayload({schemaVersion:2,projectId:'prj-owned',bindingId:sha,instanceId:id,revision:1,agents:[agent],modelRequirements:[requirement]} as never);
    it('keeps catalog ID and pin canonical while compiling the selected native source',()=>{
        const payload=source(),compiled=compileProjectAgents(payload,[mapping] as never);
        expect(payload.modelRequirements[0]).toMatchObject({modelPin:sha,runtime:'device-codex',sourceSelector:'codexbridge/alias'});
        expect(compiled.mappings[0]).toMatchObject({provider:'codexbridge',configKey:'alias'});
    });
    it.each([{provider:'other'},{model:'another'},{options:{temperature:0}},{baseUrl:'https://example.test/v1'},{runtime:'remote-ollama'}])('mismatched native model cannot satisfy catalog pin: %j',change=>{
        expect(()=>compileProjectAgents(source(),[{...mapping,...change}] as never)).toThrow();
    });
});
