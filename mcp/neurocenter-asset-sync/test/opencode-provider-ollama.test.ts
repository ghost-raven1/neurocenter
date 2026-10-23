import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'jsonc-parser';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,providerSession,noop} from './opencode-provider.fixture.js';
import {providerContext} from '../src/features/opencode-providers/context.js';
import {saveProvider,providerStatus} from '../src/features/opencode-providers/engine.js';
import {providerConfig,providerProof} from '../src/features/opencode-providers/receipt.js';
import {readOpenCodeModelMetadata} from '../src/bridge/opencode-model-scan.js';
import {closeProviderSessions} from '../src/features/opencode-providers/server.js';
import type {OpenCodeProviderDescriptor} from '../src/features/opencode-providers/contract.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{await closeProviderSessions();await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(baseUrl='https://ollama.example.test'){
    const f=await providerFixture();cleanup.push(f.cleanup);
    const descriptor={...f.descriptor,providerKind:'ollama',providerId:'neurocenter-ollama-'+'a'.repeat(16),expectations:{...f.descriptor.expectations!,baseUrl,runtimeModel:'qwen3:8b'}} as OpenCodeProviderDescriptor;
    return {...f,descriptor,context:await providerContext(descriptor,noop)};
}

describe('Managed native Ollama provider',()=>{
    it('configures the native API without a key, preserving manual providers/defaults/comments and exact generation settings',async()=>{
        const f=await fixture(),file=path.join(f.root,providerConfig);await fs.mkdir(path.dirname(file),{recursive:true});
        await fs.writeFile(file,'// KEEP\n{"model":"manual/default","plugin":["manual-plugin"],"provider":{"manual":{}}}\n');
        const status=await saveProvider(f.context,undefined,null,noop),config=parse(await fs.readFile(file,'utf8'));
        expect(status).toMatchObject({state:'configured',ready:true,missingFields:[]});
        expect(config).toMatchObject({model:'manual/default',plugin:['manual-plugin'],provider:{manual:{}}});
        const entry=config.provider[f.descriptor.providerId];expect(entry.npm).toMatch(/^file:.*\/ollama-sdk\.(?:js|ts)$/);
        expect(entry.options).toEqual({baseURL:'https://ollama.example.test'});expect(entry.models['qwen3:8b']).toMatchObject({id:'qwen3:8b',options:{temperature:0.3,maxOutputTokens:1024,contextWindow:32000},limit:{context:32000}});
        expect((await providerProof(f.context))!.receipt.credentialFile).toBe('');expect(JSON.stringify(status)).not.toContain('ollama.example');
        expect(await fs.readFile(file,'utf8')).toContain('// KEEP');
    });
    it('keeps a configured local key unless explicitly replaced or removed, never exporting it through normal model synchronization',async()=>{
        const f=await fixture(),first=await saveProvider(f.context,'OLLAMA_LOCAL_ONLY',null,noop),proof=await providerProof(f.context);
        expect(await fs.readFile(proof!.receipt.credentialFile,'utf8')).toBe('OLLAMA_LOCAL_ONLY');
        const second=await saveProvider(f.context,undefined,first.revision,noop);expect((await providerProof(f.context))!.receipt.credentialFile).toBe(proof!.receipt.credentialFile);
        const credentials:Record<string,string>={},scan=await readOpenCodeModelMetadata(f.root,{scope:'project',projectId:f.descriptor.projectId,bindingId:f.descriptor.bindingId,instanceId:f.descriptor.instanceId},{credentialTarget:credentials});
        expect(scan.candidates).toContainEqual(expect.objectContaining({provider:f.descriptor.providerId,runtime:'remote-ollama',hasKey:true,blocker:null}));
        expect(credentials).toEqual({});expect(JSON.stringify(scan)).not.toContain('OLLAMA_LOCAL_ONLY');
        const removed=await saveProvider(f.context,null,second.revision,noop),config=parse(await fs.readFile(path.join(f.root,providerConfig),'utf8'));
        expect(removed.ready).toBe(true);expect(config.provider[f.descriptor.providerId].options).not.toHaveProperty('apiKey');expect((await providerProof(f.context))!.receipt.credentialFile).toBe('');
        expect(await fs.readFile(proof!.receipt.credentialFile,'utf8')).toBe('OLLAMA_LOCAL_ONLY');
    });
    it('allows an exact loopback setup readback without pretending the computer endpoint can be imported to the server',async()=>{
        const f=await fixture('http://127.0.0.1:11434');expect((await saveProvider(f.context,undefined,null,noop)).ready).toBe(true);
        const scan=await readOpenCodeModelMetadata(f.root,{scope:'project',projectId:f.descriptor.projectId,bindingId:f.descriptor.bindingId,instanceId:f.descriptor.instanceId});
        expect(scan.candidates[0]).toMatchObject({runtime:'remote-ollama',baseUrl:'http://127.0.0.1:11434',blocker:'device-local-endpoint'});
    });
    it.each(['transport','key','model','disabled'])('keeps manual %s overrides and refuses false readiness',async field=>{
        const f=await fixture();await saveProvider(f.context,undefined,null,noop);
        const override=field==='transport'?{npm:'@ai-sdk/openai-compatible'}:field==='key'?{options:{apiKey:'MANUAL_OTHER'}}:{models:{other:{}}};
        vi.stubEnv('OPENCODE_CONFIG_CONTENT',JSON.stringify(field==='disabled'?{disabled_providers:[f.descriptor.providerId]}:{provider:{[f.descriptor.providerId]:override}}));
        expect((await providerStatus(f.context,noop)).state).toBe('conflict');
    });
    it('the local wizard accepts no key and explicit removal with the same CSRF/CAS protection',async()=>{
        const f=await fixture(),first=await saveProvider(f.context,'LOCAL_KEY',null,noop),s=await providerSession(f),form=await(await s.bootstrap()).json() as {csrf:string;credentialConfigured:boolean;revision:string};
        expect(form.credentialConfigured).toBe(true);expect(form.revision).toBe(first.revision);
        const page=await(await fetch(s.url.origin)).text();expect(page).toContain('Удалить сохранённый ключ');
        const saved=await s.post('/save',{apiKey:null,expectedRevision:first.revision},form.csrf);expect(saved.status).toBe(200);expect(await saved.json()).toEqual({ready:true,state:'configured'});
        expect((await providerProof(f.context))!.receipt.credentialFile).toBe('');
    });
    it('does not mark a missing key or a manual auth.json override as a configured keyless provider',async()=>{
        const f=await fixture(),first=await saveProvider(f.context,'PRIVATE_KEY',null,noop),file=(await providerProof(f.context))!.receipt.credentialFile;
        await fs.unlink(file);expect(await providerStatus(f.context,noop)).toMatchObject({ready:false,missingFields:['credential']});
        await saveProvider(f.context,null,first.revision,noop);
        const auth=path.join(f.home,'.local/share/opencode/auth.json');await fs.mkdir(path.dirname(auth),{recursive:true});await fs.writeFile(auth,JSON.stringify({[f.descriptor.providerId]:{type:'api',key:'MANUAL_AUTH_KEY'}}));
        expect((await providerStatus(f.context,noop)).state).toBe('conflict');
    });
    it('explicit removal stays Ollama-only and a stale revision cannot replace the active credential',async()=>{
        const f=await providerFixture();cleanup.push(f.cleanup);await expect(saveProvider(f.context,null,null,noop)).rejects.toThrow('ключ');
        const native=await fixture(),first=await saveProvider(native.context,'STILL_CURRENT',null,noop),before=await fs.readFile(path.join(native.root,providerConfig),'utf8');
        await expect(saveProvider(native.context,null,null,noop)).rejects.toThrow('Конфликт');expect(await fs.readFile(path.join(native.root,providerConfig),'utf8')).toBe(before);expect((await providerStatus(native.context,noop)).revision).toBe(first.revision);
    });
});
