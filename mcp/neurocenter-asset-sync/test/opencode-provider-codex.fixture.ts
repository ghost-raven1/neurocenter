import {Readable} from 'node:stream';
import {vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash} from '../src/bridge/state.js';
import {ensureRuntimeArtifact} from '../src/features/runtime-artifacts/cache.js';
import {runtimeArtifactTarget} from '../src/features/runtime-artifacts/model.js';
import {providerContext} from '../src/features/opencode-providers/context.js';
import type {OpenCodeProviderDescriptor} from '../src/features/opencode-providers/contract.js';
import {providerFixture,noop} from './opencode-provider.fixture.js';
/** Trusted tiny fixture module; it has no auth/network/worker/inference implementation. */
const setup=`export async function readCodexModels({signal}={}){signal?.throwIfAborted();process.env.QA_CODEX_READS=String(Number(process.env.QA_CODEX_READS||0)+1);if(process.env.QA_CODEX_HOLD_METADATA==='1'){process.env.QA_CODEX_METADATA_STARTED='1';await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{process.env.QA_CODEX_METADATA_CANCELLED='1';reject(signal.reason);},{once:true}));}if(process.env.QA_CODEX_LOGGED!=='1')throw Object.assign(Error('login'),{code:'CODEX_LOGIN_REQUIRED'});return {models:[{id:'qa-codex',name:'Local Codex metadata',inputModalities:['text','image']}],defaultModel:'qa-codex'};}
export async function beginCodexSetupLogin({signal}={}){signal?.throwIfAborted();process.env.QA_CODEX_LOGINS=String(Number(process.env.QA_CODEX_LOGINS||0)+1);let finish;const finished=new Promise(r=>finish=r);if(process.env.QA_CODEX_IMMEDIATE_LOGIN==='1')finish();signal?.addEventListener('abort',()=>{finish();},{once:true});return {url:'https://auth.openai.com/authorize?fixture=true',finished,async close(){process.env.QA_CODEX_CLOSED=String(Number(process.env.QA_CODEX_CLOSED||0)+1);finish();}};}`;
export async function codexFixture(extraFiles:Array<{path:string;content:string}>=[]){
    const f=await providerFixture();for(const key of ['QA_CODEX_LOGGED','QA_CODEX_LOGINS','QA_CODEX_CLOSED','QA_CODEX_READS','QA_CODEX_HOLD_METADATA','QA_CODEX_METADATA_STARTED','QA_CODEX_METADATA_CANCELLED','QA_CODEX_IMMEDIATE_LOGIN'])vi.stubEnv(key,'0');
    const {archive,descriptor:artifact}=artifactFixture([{path:'codex-plugin.mjs',content:'export function createManagedCodexPlugin(){return async()=>({});}'},{path:'codex-setup.mjs',content:setup},...extraFiles],runtimeArtifactTarget());
    const sourceCommit='de21db304bef59af6421079c10e8a43404fd09fa',pkg:Package={schemaVersion:5,plugin:{id:'qa-codex-connector',name:'Codex fixture',kind:'plugin',version:1},config:{extra:{runtimeArtifacts:[artifact],codexConnector:{schemaVersion:1,sourceCommit,version:'0.2.0',sdkVersion:'0.159.3',authOnly:true}}},files:[],manifest:{sha256:'',filesCount:0}};
    pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]})));
    const descriptor:OpenCodeProviderDescriptor={...f.descriptor,providerId:'neurocenter-codex-'+'a'.repeat(16),providerKind:'codex-bridge',expectations:null,connector:{assetId:pkg.plugin.id,version:1,manifest:pkg.manifest.sha256,sourceCommit}};
    const resolution=await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([archive])});return {...f,descriptor,pkg,resolution:resolution!,context:await providerContext(descriptor,noop,pkg)};
}
