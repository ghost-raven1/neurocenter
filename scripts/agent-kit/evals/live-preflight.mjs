import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readOwnedFile} from '../../dev-mcp/safe-file.mjs';

export const disabledFeatures=['apps','plugins','hooks','shell_tool','browser_use','browser_use_external','computer_use','multi_agent','memories','chronicle','skill_search','workspace_dependencies','image_generation','in_app_browser','code_mode_host','remote_plugin'];
const ttl=15*60*1000,digest=value=>createHash('sha256').update(value).digest('hex');
const mockScript=fileURLToPath(new URL('./mock-server.mjs',import.meta.url));
const clean=result=>result?.ok===true&&result.code===0&&result.signal===null&&result.timedOut===false&&result.leaderReaped===true&&result.cleanup?.noLiveDescendants===true&&!result.failure&&result.stderr==='';
const fail=code=>{throw Error(code);};
const json=text=>{const value=JSON.parse(text);if(!value||typeof value!=='object')fail('JSON_SHAPE');return value;};

/** Resolve the current PATH once and fingerprint the exact regular executable, without launching it. */
export async function cliIdentity(){
    let selected;
    for(const folder of (process.env.PATH??'').split(path.delimiter)){
        const candidate=path.resolve(folder||'.','codex');
        try{await fs.access(candidate,constants.X_OK);selected=await fs.realpath(candidate);break;}catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
    }
    if(!selected)fail('CLI_NOT_FOUND');
    const handle=await fs.open(selected,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const before=await handle.stat();if(!before.isFile()||before.size>512*1024**2)fail('CLI_UNSAFE');
        const hash=createHash('sha256'),buffer=Buffer.alloc(512*1024);let total=0;
        while(total<before.size){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,before.size-total),total);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));total+=bytesRead;}
        const after=await handle.stat(),current=await fs.lstat(selected);
        if(total!==before.size||current.isSymbolicLink()||!current.isFile()||['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]||after[key]!==current[key]))fail('CLI_CHANGED');
        return {path:selected,sha256:hash.digest('hex'),bytes:total,pathSha256:digest(process.env.PATH??'')};
    }finally{await handle.close();}
}

export async function assertCliIdentity(expected){if(!isDeepStrictEqual(expected,await cliIdentity()))fail('CLI_OR_PATH_CHANGED');}
const binding=plan=>({planSha256:digest(JSON.stringify(plan)),identity:plan.identity,versions:plan.versions,runtime:{node:process.execPath,version:process.version}});
const expectedMcp=(plan,entry)=>({type:'stdio',command:process.execPath,args:[mockScript,path.join(entry.directory,'host-operations.json'),path.join(entry.directory,'mock-ledger.jsonl'),plan.id+':'+entry.scenario],env:null,env_vars:[],cwd:null});
const commands=(entry,prompt)=>({features:['features','list'],mcp:['mcp','list','--json'],prompt:['debug','prompt-input',prompt]});

function renderedBoundary(messages,entry){
    if(!Array.isArray(messages))return false;
    const chunks=role=>messages.filter(message=>message?.type==='message'&&message.role===role&&Array.isArray(message.content))
        .flatMap(message=>message.content.filter(content=>content?.type==='input_text'&&typeof content.text==='string').map(content=>content.text.replace(/\r\n/g,'\n')));
    const permissions=chunks('developer').map(text=>/^<permissions instructions>\n([\s\S]*)\n<\/permissions instructions>$/.exec(text)).filter(Boolean);
    if(permissions.length!==1)return false;
    const modes=[...permissions[0][1].matchAll(/`sandbox_mode` is `([^`]+)`/g)],approvals=[...permissions[0][1].matchAll(/^Approval policy is currently ([^.]+)\./gm)];
    if(modes.length!==1||modes[0][1]!=='read-only'||approvals.length!==1||approvals[0][1]!=='never')return false;
    const environments=chunks('user').filter(text=>digest(text)!==entry.promptSha256).map(text=>/^<environment_context>\n([\s\S]*)\n<\/environment_context>$/.exec(text)).filter(Boolean);
    if(environments.length!==1)return false;
    const directories=[...environments[0][1].matchAll(/^[ \t]*<cwd>([^<>\r\n]*)<\/cwd>[ \t]*$/gm)];
    return directories.length===1&&directories[0][1]===entry.workspace;
}

/** Classify fixed metadata only. A matching bundled catalog never proves account/inference access. */
export function classifyPreflight(plan,results){
    const failures=[];let unknown=false;
    const check=(condition,code)=>{if(!condition)failures.push(code);};
    const decode=(result,parse,label)=>{
        if(!clean(result)){unknown=true;failures.push(label+'_PROCESS_UNCONFIRMED');return null;}
        try{return parse(result.stdout);}catch{unknown=true;failures.push(label+'_OUTPUT_UNKNOWN');return null;}
    };
    const version=decode(results.version,text=>{if(!/^codex-cli [^\r\n]+\n?$/.test(text)||text.length>256)fail('VERSION');return text.trim();},'VERSION');
    const catalog=decode(results.catalog,json,'CATALOG');
    if(catalog){
        if(!Array.isArray(catalog.models)||catalog.models.length>1000){unknown=true;failures.push('CATALOG_OUTPUT_UNKNOWN');}
        else{
            const matches=catalog.models.filter(model=>model?.slug===plan.identity.model);
            check(matches.length===1,'EXACT_MODEL_NOT_IN_BUNDLED_CATALOG');
            if(matches.length===1){const levels=matches[0].supported_reasoning_levels;
                if(!Array.isArray(levels)||levels.some(level=>!level||typeof level.effort!=='string')){unknown=true;failures.push('REASONING_METADATA_UNKNOWN');}
                else check(levels.some(level=>level.effort===plan.identity.reasoning),'EXACT_REASONING_UNSUPPORTED');
            }
        }
    }
    check(Array.isArray(results.entries)&&results.entries.length===plan.entries.length,'SIX_HOME_CAPTURE_REQUIRED');
    for(const [index,entry]of plan.entries.entries()){
        const capture=results.entries?.[index];if(capture?.scenario!==entry.scenario){failures.push('SCENARIO_CAPTURE_MISMATCH');continue;}
        const features=decode(capture.features,text=>{
            const values={};for(const line of text.trim().split('\n')){const match=/^([a-z][a-z0-9_]*)\s+.+?\s+(true|false)$/.exec(line.trim());if(!match||Object.hasOwn(values,match[1]))fail('FEATURE_FORMAT');values[match[1]]=match[2]==='true';}return values;
        },'FEATURES');
        if(features)for(const name of disabledFeatures)check(features[name]===false,'MANDATORY_FEATURE_NOT_DISABLED:'+name);
        const servers=decode(capture.mcp,json,'MCP');
        if(servers)check(Array.isArray(servers)&&servers.length===1&&servers[0]?.name==='eval_mock'&&servers[0].enabled===true&&servers[0].disabled_reason===null
            &&isDeepStrictEqual(servers[0].transport,expectedMcp(plan,entry))&&servers[0].startup_timeout_sec===15&&servers[0].tool_timeout_sec===15,'MCP_ISOLATION_MISMATCH');
        const prompt=decode(capture.prompt,json,'PROMPT');
        if(prompt){
            check(Array.isArray(prompt)&&prompt.length>0&&prompt.some(message=>message?.type==='message'&&message.role==='user'
                &&Array.isArray(message.content)&&message.content.some(content=>content?.type==='input_text'&&typeof content.text==='string'&&digest(content.text)===entry.promptSha256)),'PROMPT_INPUT_MISMATCH');
            check(renderedBoundary(prompt,entry),'RENDERED_PERMISSIONS_OR_CWD_MISMATCH');
        }
    }
    return {status:failures.length?(unknown?'unknown':'incompatible'):'compatible',access:'unverified',modelCalls:0,cliVersion:version,failures:[...new Set(failures)],
        note:'Bundled model metadata, effective features/MCP and rendered prompt were checked. Account inference access and the complete request tool list remain unverified.'};
}

async function captureFile(root,relative,value){
    const text=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(text)>5*1024**2)fail('CAPTURE_TOO_LARGE');
    await fs.writeFile(path.join(root,relative),text,{mode:0o600,flag:'wx'});return {file:relative,sha256:digest(text)};
}

/** Capture only fixed local metadata commands in each already-prepared private home; never exec a task. */
export async function writePreflight(plan,invoke){
    const output=path.dirname(plan.entries[0].directory),cli=await cliIdentity(),directory='preflight-'+randomUUID();
    await fs.mkdir(path.join(output,directory),{mode:0o700});
    const results={entries:[]},captures={entries:[]};
    const collect=async(name,args,entry)=>{
        const result={...await invoke(args,{home:entry.home,cwd:entry.workspace,executable:cli.path,timeoutMs:30000}),invocation:{args,home:entry.home,cwd:entry.workspace,executable:cli.path}};
        return {result,capture:await captureFile(output,directory+'/'+name+'.json',result)};
    };
    for(const [name,args]of [['version',['--version']],['catalog',['debug','models','--bundled']]]){
        const captured=await collect(name,args,plan.entries[0]);results[name]=captured.result;captures[name]=captured.capture;
    }
    for(const [index,entry]of plan.entries.entries()){
        const result={scenario:entry.scenario},capture={scenario:entry.scenario};
        const prompt=(await readOwnedFile(entry.directory,'prompt.md',{limit:128*1024})).text;
        for(const [name,args]of Object.entries(commands(entry,prompt))){
            const item=await collect(index+'-'+name,args,entry);result[name]=item.result;capture[name]=item.capture;
        }
        results.entries.push(result);captures.entries.push(capture);
    }
    await assertCliIdentity(cli);
    const createdAt=new Date().toISOString(),receipt={schemaVersion:1,kind:'native-codex-metadata-preflight',id:plan.id,createdAt,expiresAt:new Date(Date.parse(createdAt)+ttl).toISOString(),
        ...binding(plan),cli,captures,...classifyPreflight(plan,results)};
    const text=JSON.stringify(receipt,null,2)+'\n';if(Buffer.byteLength(text)>128*1024)fail('PREFLIGHT_TOO_LARGE');
    try{const previous=await fs.lstat(path.join(output,'preflight.json'));if(!previous.isFile()||previous.isSymbolicLink()||previous.nlink!==1)fail('UNSAFE_PREFLIGHT');}catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(output,'.preflight-'+randomUUID()+'.json');
    await fs.writeFile(temporary,text,{mode:0o600,flag:'wx'});await fs.rename(temporary,path.join(output,'preflight.json'));
    return receipt;
}

/** Re-read bounded owned captures and reclassify them before creating a start/budget marker. */
export async function requirePreflight(plan){
    const output=path.dirname(plan.entries[0].directory),info=await fs.lstat(path.join(output,'preflight.json'));
    if((info.mode&0o077)!==0)fail('UNSAFE_PREFLIGHT_MODE');
    const receipt=JSON.parse((await readOwnedFile(output,'preflight.json',{limit:128*1024})).text),now=Date.now();
    if(receipt.schemaVersion!==1||receipt.kind!=='native-codex-metadata-preflight'||receipt.id!==plan.id||receipt.access!=='unverified'||receipt.modelCalls!==0
        ||!Number.isFinite(Date.parse(receipt.createdAt))||Date.parse(receipt.createdAt)>now||Date.parse(receipt.expiresAt)!==Date.parse(receipt.createdAt)+ttl||now>Date.parse(receipt.expiresAt)
        ||!isDeepStrictEqual(binding(plan),{planSha256:receipt.planSha256,identity:receipt.identity,versions:receipt.versions,runtime:receipt.runtime}))fail('PREFLIGHT_STALE_OR_CHANGED');
    const read=async(capture,args,entry)=>{
        if(!capture||!/^preflight-[0-9a-f-]{36}\/(version|catalog|[0-5]-(features|mcp|prompt))\.json$/.test(capture.file))fail('PREFLIGHT_CAPTURE_PATH');
        const text=(await readOwnedFile(output,capture.file,{limit:5*1024**2})).text;if(digest(text)!==capture.sha256)fail('PREFLIGHT_CAPTURE_CHANGED');
        const result=JSON.parse(text);if(!isDeepStrictEqual(result.invocation,{args,home:entry.home,cwd:entry.workspace,executable:receipt.cli.path}))fail('PREFLIGHT_CAPTURE_INVOCATION');return result;
    };
    const captures=receipt.captures,results={version:await read(captures?.version,['--version'],plan.entries[0]),catalog:await read(captures?.catalog,['debug','models','--bundled'],plan.entries[0]),entries:[]};
    if(captures.entries?.length!==6)fail('SIX_HOME_CAPTURE_REQUIRED');
    for(const [index,capture]of captures.entries.entries()){
        const entry=plan.entries[index],prompt=(await readOwnedFile(entry.directory,'prompt.md',{limit:128*1024})).text,result={scenario:capture.scenario};
        for(const [name,args]of Object.entries(commands(entry,prompt)))result[name]=await read(capture[name],args,entry);
        results.entries.push(result);
    }
    const classified=classifyPreflight(plan,results);
    if(receipt.status!=='compatible'||classified.status!=='compatible'||Object.entries(classified).some(([key,value])=>!isDeepStrictEqual(value,receipt[key])))fail('PREFLIGHT_INCOMPATIBLE');
    await assertCliIdentity(receipt.cli);return receipt;
}
