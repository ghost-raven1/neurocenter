import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {prepareCodexBridge} from '../recipes/codex-bridge.mjs';
import source from './fixtures/codex-auth.json' with {type:'json'};
import pin from '../../../services/shared/codex-connector-pin.json' with {type:'json'};
const require=createRequire(new URL('../../../mcp/neurocenter-asset-sync/package.json',import.meta.url)),zod=path.dirname(require.resolve('zod/package.json'));

const rpc=`import readline from 'node:readline';import fs from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const msg=JSON.parse(line);if(msg.id===undefined)continue;
 if(process.env.QA_CODEX_RPC_LOG)fs.appendFileSync(process.env.QA_CODEX_RPC_LOG,JSON.stringify({pid:process.pid,method:msg.method,params:msg.params})+'\\n');
 let result={};
 if(msg.method==='getAuthStatus'){const account=/account-[ab]$/.exec(process.env.CODEX_HOME||'')?.[0]||'synthetic-account';const claims={exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:account}};result=process.env.QA_CODEX_LOGIN==='missing'?{authMethod:null,authToken:null}:{authMethod:'chatgpt',authToken:'fixture.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture'};}
 if(msg.method==='model/list'){if(process.env.QA_CODEX_HANG==='models')continue;result={data:[{model:'gpt-synthetic',displayName:'Synthetic',isDefault:true,hidden:false,inputModalities:['text'],defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:process.env.QA_CODEX_PAGINATION==='loop'?'same':null};}
 if(msg.method==='config/read')result={config:{model:'gpt-synthetic'}};
 if(msg.method==='account/login/start'){if(process.env.QA_CODEX_HANG==='login')continue;result={type:'chatgpt',authUrl:process.env.QA_CODEX_LOGIN_URL||'https://auth.openai.com/authorize?test=synthetic',loginId:'synthetic-login'};setTimeout(()=>send({method:'account/login/completed',params:{loginId:'synthetic-login',success:true}}),500);}
 send({id:msg.id,result});
}`;

export async function codexFixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-codex-test-'))),directory=path.join(root,'runtime');
 const downloads=[],installs=[];
 await fs.mkdir(path.join(root,'sources'));
 for(const [name,content]of Object.entries(source.files))await fs.writeFile(path.join(root,'sources',name),content);
 let result;try{result=await prepareCodexBridge({target:'darwin-arm64',directory},{
  async downloadFile(url,sha){const name=url.split('/').at(-1),content=source.files[name];if(!content||createHash('sha256').update(content).digest('hex')!==sha||pin.files[name]!==sha||!url.includes('/'+pin.sourceCommit+'/'))throw new Error('fixture source pin mismatch');downloads.push(name);return path.join(root,'sources',name);},
  async install(base,dependencies,target){installs.push({dependencies,target});const vendor=path.join(base,'node_modules/@openai/codex-darwin-arm64');await fs.mkdir(path.join(vendor,'vendor/aarch64-apple-darwin/bin'),{recursive:true});await fs.writeFile(path.join(vendor,'package.json'),JSON.stringify({version:'0.159.3-darwin-arm64'}));await fs.writeFile(path.join(vendor,'vendor/aarch64-apple-darwin/bin/codex'),'synthetic binary');await fs.writeFile(path.join(base,'package.json'),JSON.stringify({type:'module'}));await fs.cp(zod,path.join(base,'node_modules/zod'),{recursive:true});},
 });}catch(error){await fs.rm(root,{recursive:true,force:true});throw error;}
 const rpcFile=path.join(root,'rpc.mjs');await fs.writeFile(rpcFile,rpc);
 await fs.writeFile(path.join(directory,'upstream/executable.js'),`export function codexExecutable(){return {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(rpcFile)}]};}`);
 const guard=path.join(root,'permit.cjs'),log=path.join(root,'permit.log');
 await fs.writeFile(guard,`const fs=require('node:fs');const value=JSON.parse(process.argv[4]);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');process.stdout.write(JSON.stringify({ok:true,allowed:process.env.QA_CODEX_DENY!=='1'}));`);
 const options={providerId:'neurocenter-codex-0123456789abcdef',projectRoot:root,codexHome:path.join(root,'codex-profile'),bridgeCommand:[process.execPath,guard],preparationId:'11111111-1111-4111-8111-111111111111',setupJobId:'22222222-2222-4222-8222-222222222222',schemaDigest:'a'.repeat(64)};
 return {root,directory,downloads,installs,result,options,log,async plugin(){return import(pathToFileURL(path.join(directory,'codex-plugin.mjs')).href);},async setup(){return import(pathToFileURL(path.join(directory,'codex-setup.mjs')).href);},async close(){await fs.rm(root,{recursive:true,force:true});}};
}
