import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {opencodeModelCandidates,readOpenCodeModelMetadata} from '../src/bridge/opencode-model-scan.js';
import {modelScanDigest,validModelScan} from '../../../services/shared/opencode-model-scan.cjs';

const secret='private-fixture-value-never-export';
const config=(options:Record<string,unknown>={},baseURL='https://api.example.test/v1',provider='team')=>({provider:{[provider]:{npm:'@ai-sdk/openai',options:{baseURL},models:{exact:{id:'exact-upstream',limit:{context:200000,output:32000},modalities:{input:['text','image']},options}}}}});
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));});
async function fixture(value:Record<string,unknown>){
    const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc opencode compatibility ')));directories.push(home);
    const root=path.join(home,'project');await fs.mkdir(root);await fs.mkdir(path.join(home,'.config/opencode'),{recursive:true});
    const file=path.join(home,'.config/opencode/opencode.json');await fs.writeFile(file,JSON.stringify(value));
    return {home,root,file,managedDirectory:path.join(home,'managed'),environment:{XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share')}};
}
const source={scope:'global' as const,deviceId:randomUUID()};

describe('Exact OpenCode protocol and parameter discovery',()=>{
    it('Records OpenAI Responses and its OpenCode store=false default, plus exact effort/limits/modalities',()=>{
        expect(opencodeModelCandidates(config({reasoningEffort:'high',store:false}))[0]).toMatchObject({model:'exact-upstream',modelVersion:'exact-upstream',capability:'vision',runtime:'remote-openai',blocker:null,
            options:{apiFormat:'responses',reasoningEffort:'high',store:false,contextWindow:200000},outputTokenLimit:32000});
        expect(opencodeModelCandidates(config())[0]!.options).toEqual({apiFormat:'responses',store:false,contextWindow:200000});
        expect(opencodeModelCandidates(config({store:true}))[0]!.options?.store).toBe(true);
    });
    it('Unknown nested options stay in the source and yield exact names/types without values or false readiness',async()=>{
        const f=await fixture(config({temperature:0,custom:{key:secret},enabled:false,items:[secret],nullable:null})),before=await fs.readFile(f.file);
        const scan=await readOpenCodeModelMetadata(f.root,source,{...f,readAuth:false});
        expect(scan.candidates[0]).toMatchObject({blocker:'unsupported-provider',parameterIssues:[{name:'custom',type:'object'},{name:'enabled',type:'boolean'},{name:'items',type:'array'},{name:'nullable',type:'null'}]});
        expect(scan.candidates[0]).not.toHaveProperty('options');expect(JSON.stringify(scan)).not.toContain(secret);expect(await fs.readFile(f.file)).toEqual(before);expect(validModelScan(scan,source)).toBe(true);
    });
    it('Unknown provider parameters and custom headers also disclose names/types only',()=>{
        const value=config();Object.assign(value.provider.team.options,{customProvider:{key:secret},nullable:null,headers:{'X-Private':secret}});
        const candidate=opencodeModelCandidates(value)[0]!;
        expect(candidate).toMatchObject({blocker:'unsupported-provider',parameterIssues:[{name:'customProvider',type:'object'},{name:'nullable',type:'null'},{name:'headers',type:'object'}]});
        expect(JSON.stringify(candidate)).not.toContain(secret);expect(JSON.stringify(candidate)).not.toContain('X-Private');
    });
    it.each(['unsupported','{env:PRIVATE_EFFORT}',0,null])('Invalid effort %s remains blocked without exposing values',reasoningEffort=>{
        const candidate=opencodeModelCandidates(config({reasoningEffort}))[0]!;expect(candidate.blocker).toBe('unsupported-provider');expect(candidate).not.toHaveProperty('options');
        expect(JSON.stringify(candidate)).not.toContain('PRIVATE_EFFORT');
    });
    it('Known CodexBridge transport cannot become a server API or transfer a marker/session by enabling Responses',async()=>{
        const f=await fixture(config({reasoningEffort:'high',store:false},'https://chatgpt.com/backend-api/codex','codexbridge'));
        await fs.mkdir(path.join(f.home,'.local/share/opencode'),{recursive:true});await fs.writeFile(path.join(f.home,'.local/share/opencode/auth.json'),JSON.stringify({codexbridge:{type:'api',key:secret}}));
        const credentials:Record<string,string>={},scan=await readOpenCodeModelMetadata(f.root,source,{...f,credentialTarget:credentials});
        expect(scan.candidates[0]).toMatchObject({blocker:'codex-local-auth',options:{apiFormat:'responses',reasoningEffort:'high',store:false}});expect(credentials).toEqual({});expect(JSON.stringify(scan)).not.toContain(secret);
        expect(validModelScan(scan,source)).toBe(true);
    });
    it.each(['missing-sdk','custom-options','model-override'])('Local Codex recovery remains explicit with %s instead of a generic provider error',async variation=>{
        const value=config({},'https://chatgpt.com/backend-api/codex','codexbridge');
        if(variation==='missing-sdk')delete (value.provider.codexbridge as {npm?:string}).npm;
        if(variation==='custom-options')Object.assign(value.provider.codexbridge.models.exact.options,{localOnly:{key:secret}});
        if(variation==='model-override')Object.assign(value.provider.codexbridge.models.exact,{provider:{npm:'local-sdk'}});
        const f=await fixture(value),credentials:Record<string,string>={};
        const scan=await readOpenCodeModelMetadata(f.root,source,{...f,credentialTarget:credentials,readAuth:false});
        expect(scan.candidates[0]!.blocker).toBe('codex-local-auth');
        expect(validModelScan(scan,source)).toBe(true);expect(credentials).toEqual({});expect(JSON.stringify(scan)).not.toContain(secret);
        const disabled=opencodeModelCandidates({...value,disabled_providers:['codexbridge']});
        expect(disabled[0]!.blocker).toBe('disabled-provider');
    });
    it('OAuth owned by another local provider stays local and cannot be silently treated as a server API key',()=>{
        expect(opencodeModelCandidates(config(),{team:{type:'oauth',access:secret,refresh:secret}})[0]!.blocker).toBe('local-provider-auth');
    });
    it.each(['http://localhost:1234/v1','http://localhost.:1234/v1','http://127.0.0.2/v1','http://[::1]:1234/v1','http://2130706433/v1'])('Computer endpoint %s is not the server endpoint',baseURL=>{
        const candidate=opencodeModelCandidates(config({},baseURL))[0]!;expect(candidate.blocker).toBe('device-local-endpoint');expect(candidate.baseUrl).toBeTruthy();
    });
    it('Recomputed unblocked Codex/loopback snapshots and secret diagnostic fields still fail the shared boundary',async()=>{
        const f=await fixture(config()),scan=await readOpenCodeModelMetadata(f.root,source,{...f,readAuth:false});
        for(const patch of [{provider:'codexbridge'},{baseUrl:'http://127.0.0.1/v1'},{parameterIssues:[{name:'custom',type:'object',value:secret}]}]){
            const changed=structuredClone(scan);Object.assign(changed.candidates[0]!,patch);changed.digest=modelScanDigest(changed);expect(validModelScan(changed,source)).toBe(false);
        }
        const changed=structuredClone(scan);changed.candidates[0]!.options!.store=true;expect(validModelScan(changed,source)).toBe(false);
    });
});
