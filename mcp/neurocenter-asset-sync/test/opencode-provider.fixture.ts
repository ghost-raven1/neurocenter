import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {setRoot,bindProject,projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {writeState} from '../src/bridge/state.js';
import {providerContext} from '../src/features/opencode-providers/context.js';
import {openOpenCodeProvider,prepareOpenCodeProvider} from '../src/features/opencode-providers/index.js';
import type {OpenCodeProviderDescriptor} from '../src/features/opencode-providers/contract.js';
import type {Package} from '../src/bridge/package.js';
export const noop=async()=>{};
export const fixtures:Array<{temporary:string;closed:boolean}>=[];
/** All identity, project, HOME and key material belong to this temporary workspace. */
export async function providerFixture(){
    const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-provider-'))),root=path.join(temporary,'projects','project'),home=path.join(temporary,'home');
    await fs.mkdir(root,{recursive:true});await fs.mkdir(path.join(root,'.git'));await fs.mkdir(home);
    for(const [key,value]of Object.entries({HOME:home,CODEX_HOME:'',NEUROCENTER_BRIDGE_HOME:path.join(temporary,'private'),NEUROCENTER_URL:'https://nc.example.test',XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),OPENCODE_CONFIG:'',OPENCODE_CONFIG_DIR:'',OPENCODE_CONFIG_CONTENT:'',OPENCODE_DISABLE_PROJECT_CONFIG:''}))vi.stubEnv(key,value);
    const projectId='prj-provider',deviceId=randomUUID();await setRoot(path.dirname(root));await bindProject(projectId,path.basename(root));await writeState('credentials',{deviceId,token:'DEVICE_TOKEN_MUST_STAY_PRIVATE',email:'qa@example.test'});
    const descriptor:OpenCodeProviderDescriptor={schemaVersion:1,deviceId,projectId,bindingId:await projectBindingId(projectId),instanceId:await projectInstanceId(projectId),providerId:'neurocenter-openai-'+ 'a'.repeat(16),providerKind:'openai-compatible',schemaDigest:'b'.repeat(64),connector:null,
        expectations:{catalogModelId:'model-local-test',modelPin:'c'.repeat(64),runtimeModel:'model-local',baseUrl:'https://provider.example.test/v1',capability:'chat',options:{temperature:0.3,maxOutputTokens:1024,contextWindow:32000}}};
    const record={temporary,closed:false};fixtures.push(record);
    return {temporary,root,home,descriptor,context:await providerContext(descriptor,noop),cleanup:async()=>{await fs.rm(temporary,{recursive:true,force:true});record.closed=true;}};
}
export async function providerSession(f:Awaited<ReturnType<typeof providerFixture>>,authorizeSave=noop,connectorPackage?:Package){
    const preparation=await prepareOpenCodeProvider(f.descriptor,noop,connectorPackage),openJobId=randomUUID();let address='';
    const report=await openOpenCodeProvider(f.descriptor,{...preparation,openJobId,authorizeSave,connectorPackage,open:async url=>{address=url;return true;}},noop);
    const url=new URL(address),post=(route:string,value:unknown,csrf='',origin=url.origin)=>fetch(url.origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Provider-CSRF':csrf},body:JSON.stringify(value)});
    return {url,preparation,report,openJobId,post,bootstrap:()=>post('/session',{token:url.hash.slice(1)})};
}
