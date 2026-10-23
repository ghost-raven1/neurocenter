import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {codexFixture} from './opencode-provider-codex.fixture.js';
import {assertCodexModelSource} from '../src/features/device-codex-inference/model-source.js';
import {loadDeviceCodexTransport,deviceCodexConnectorPackage} from '../src/features/opencode-providers/connector.js';
import {DEVICE_CODEX_PROTOCOL,type DeviceCodexContext} from '../src/features/device-codex-inference/contract.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await Promise.all(cleanup.splice(0).map(fn=>fn()));});
async function sourceFixture(){
    const f=await providerFixture();cleanup.push(f.cleanup);
    const directory=path.join(f.home,'.config/opencode');await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,'opencode.json'),JSON.stringify({provider:{codexbridge:{npm:'@ai-sdk/openai',options:{baseURL:'https://chatgpt.com/backend-api/codex'},models:{'qa-codex':{id:'qa-codex'}}}},plugin:['arbitrary-user-plugin-must-never-execute']}));
    const context:DeviceCodexContext={protocol:DEVICE_CODEX_PROTOCOL,callId:randomUUID(),model:'qa-codex',capability:'chat',messages:[{role:'user',content:'secret prompt'}],options:{},source:{scope:'global'},
        expectedCandidate:{provider:'codexbridge',configKey:'qa-codex',model:'qa-codex',modelVersion:'qa-codex',capability:'chat',baseUrl:'https://chatgpt.com/backend-api/codex',options:{apiFormat:'responses',store:false}},connectorPackage:{},deadlineAt:new Date(Date.now()+30000).toISOString()};
    return {...f,context};
}
describe('Exact local Codex source and immutable raw transport',()=>{
    it('reads the selected global provider as metadata without loading arbitrary installed plugins',async()=>{
        const f=await sourceFixture();await expect(assertCodexModelSource(f.context,f.descriptor.deviceId,noop)).resolves.toBeUndefined();
    });
    it.each(['disabled','model','options'])('rejects a higher-priority %s change before dispatch',async kind=>{
        const f=await sourceFixture();
        const override=kind==='disabled'?{disabled_providers:['codexbridge']}:{provider:{codexbridge:{models:{'qa-codex':kind==='model'?{id:'another-model'}:{options:{reasoningEffort:'low'}}}}}};
        vi.stubEnv('OPENCODE_CONFIG_CONTENT',JSON.stringify(override));await expect(assertCodexModelSource(f.context,f.descriptor.deviceId,noop)).rejects.toThrow();
    });
    it('imports only the pinned raw auth transport and detects later runtime file tampering',async()=>{
        const f=await codexFixture([
            {path:'upstream/auth-session.js',content:'export const createSessionReader=load=>refresh=>load(refresh); export const loadSession=async()=>({accessToken:"LOCAL_TOKEN",accountId:"ACCOUNT",expiresAt:Date.now()+60000});'},
            {path:'upstream/auth-provider.js',content:'export function createCodexFetch(read,transport){return async(input,init)=>{await read(false,init.signal);return transport(input,init);};}'},
        ]);cleanup.push(f.cleanup);
        const send=vi.fn(async()=>new Response('fixture'));const transport=await loadDeviceCodexTransport(f.pkg,noop,send);await transport('https://chatgpt.com/backend-api/codex/responses',{method:'POST',signal:new AbortController().signal});expect(send).toHaveBeenCalledOnce();
        const changed=structuredClone(f.pkg);(changed.config!.extra!.codexConnector as {sourceCommit:string}).sourceCommit='f'.repeat(40);expect(()=>deviceCodexConnectorPackage(changed)).toThrow();
        const file=path.join(f.resolution.root,'upstream/auth-provider.js');await fs.chmod(file,0o600);await fs.appendFile(file,'\n// tampered');await expect(loadDeviceCodexTransport(f.pkg,noop,send)).rejects.toThrow();expect(send).toHaveBeenCalledOnce();
    });
});
