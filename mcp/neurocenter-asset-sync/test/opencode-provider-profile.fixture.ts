import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
import {bridgeCliProfileFixture,profileSite} from './bridge-cli-profile.fixture.js';
/** Real saved-profile reader, child Node/CA/proxy and HTTP; only the final provider-permit boundary is a trusted fixture. */
export async function providerProfileFixture(kind:'http'|'https'|'proxy'='http'){
    const f=await bridgeCliProfileFixture(kind),capture=path.join(f.root,'provider-profile.jsonl');
    const source=await fs.readFile(fileURLToPath(new URL('../src/bridge/cli-provider-profile.ts',import.meta.url)),'utf8');
    await fs.writeFile(path.join(f.install,'dist/bridge/cli-provider-profile.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
    const authorization=path.join(f.install,'dist/features/opencode-providers/authorization.js');await fs.mkdir(path.dirname(authorization),{recursive:true});
    await fs.writeFile(authorization,`import{appendFileSync}from'node:fs';import{readState,api,hub,apiHub}from'../../bridge/state.js';export async function authorizeManagedProvider(input){
if(process.env.HOME!==${JSON.stringify(f.runtimeHome)}||hub()!==${JSON.stringify(profileSite)}||apiHub()!==${JSON.stringify(f.api)})throw Error('Saved runtime profile was not selected');
const credentials=await readState('credentials');if(credentials?.token!=='qa-saved-profile-token')throw Error('Saved credentials unavailable');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid,home:process.env.HOME,site:hub(),api:apiHub(),ca:!!process.env.NODE_EXTRA_CA_CERTS,proxy:process.env.NODE_USE_ENV_PROXY==='1'})+'\\n');
if(process.env.QA_PROVIDER_HOLD==='1')await new Promise(()=>setInterval(()=>{},1000));
const result=await api('identity');if(!result.id)throw Error('Owned API rejected');return{ok:true,allowed:true};}`);
    const current=pathToFileURL(path.join(f.install,'dist/bridge/cli-provider-profile.js')).href,original=pathToFileURL(authorization).href;
    await fs.writeFile(path.join(f.install,'dist/bridge-cli.js'),`try{const module=await import(process.env.QA_PROVIDER_ORIGINAL==='1'?${JSON.stringify(original)}:${JSON.stringify(current)});const fn=module.authorizeInstalledProviderProfile||module.authorizeManagedProvider;process.stdout.write(JSON.stringify(await fn(JSON.parse(process.argv[2]))));}catch{process.stdout.write(JSON.stringify({ok:false}));process.exitCode=1;}`);
    return {...f,capture};
}
