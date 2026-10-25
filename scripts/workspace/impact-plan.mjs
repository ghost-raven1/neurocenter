import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {captureCheckPlan,workspacePackages} from './check-plan.mjs';
import {captureCheckSource} from './check-source.mjs';
import {regularBytes,sameSource,bounds} from './isolated-build-source.mjs';

const id=directory=>directory==='mcp/neurocenter-asset-sync'?'bridge':path.posix.basename(directory);
const packages=workspacePackages.map(id),directories=new Map(workspacePackages.map(directory=>[id(directory),directory]));
const discovery=['scripts/test','scripts/catalog-plugins/test','scripts/catalog-plugins/recipes/test','scripts/agent-kit/test'];
// Direct consumers are evidenced by source imports/fixture reads, not a complete runtime API graph.
const consumers={'catalog-service':['frontend','bridge'],bridge:['catalog-service'],'api-gateway':['frontend']};
const maxPaths=20000,maxGitBytes=8*1024**2,maxPlanBytes=8*1024**2;
const deadlineMs=30000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactRevision=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail=code=>{const error=new Error(code);error.code=code;return error;};
const cancelled=signal=>{if(signal?.aborted)throw fail('IMPACT_CANCELLED');};
const sortedObject=value=>Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)));
const safeName=name=>name.length<=1024&&!/^[\/]|[\\\x00-\x1f\x7f]/.test(name)
    &&name.split('/').every(part=>part&&part!=='.'&&part!=='..'&&Buffer.byteLength(part)<=255);
const help='Read-only conservative impact plan: node scripts/workspace/impact-plan.mjs --base <exact-local-40-or-64-hex-commit>\nNEUROCENTER_IMPACT_PLAN=0 blocks new plans. --help remains available. No checks, writes, installs or coverage run.\n';

/** Local Git only: fixed argument vectors, no hooks, external diff/textconv or optional locks. */
async function git(root,args,signal){
    cancelled(signal);
    return await new Promise((resolve,reject)=>{
        execFile('/usr/bin/git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',
            '-c','diff.external=','-c','core.pager=cat',...args],{cwd:root,encoding:'buffer',timeout:5000,maxBuffer:maxGitBytes,signal,
            env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',
                GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}},
        (error,stdout)=>signal?.aborted?reject(fail('IMPACT_CANCELLED')):error?reject(fail('IMPACT_GIT_UNAVAILABLE')):resolve(stdout));
    });
}

/** Validate the literal local commit before any source capture; revision expressions are not accepted. */
async function admit(root,baseRevision,signal){
    if(!exactRevision(baseRevision))throw fail('IMPACT_INVALID_BASE');
    cancelled(signal);
    if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||await fs.realpath(root)!==root)throw fail('IMPACT_INVALID_ROOT');
    try{
        if((await git(root,['rev-parse','--show-toplevel'],signal)).toString('utf8').trim()!==root)throw fail('IMPACT_INVALID_ROOT');
        if((await git(root,['cat-file','-t',baseRevision],signal)).toString('utf8').trim()!=='commit')throw fail('IMPACT_INVALID_BASE');
    }catch(error){if(error.code==='IMPACT_CANCELLED'||error.code==='IMPACT_INVALID_ROOT')throw error;throw fail('IMPACT_INVALID_BASE');}
}

/** Compare raw object/index identities with bounded current bytes; Git never reads filtered worktree content. */
async function changes(root,baseRevision,snapshot,signal){
    try{
        if(!snapshot)throw fail('IMPACT_GIT_UNAVAILABLE');
        const readNames=async args=>{
            const bytes=await git(root,args,signal),value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
            if(value&&!value.endsWith('\0'))throw fail('IMPACT_GIT_UNAVAILABLE');
            const entries=value.split('\0').filter(Boolean);if(entries.length>maxPaths)throw fail('IMPACT_INPUT_LIMIT');return entries;
        };
        const baseline=new Map(),index=new Map();
        for(const line of await readNames(['ls-tree','-r','-z','--full-tree',baseRevision])){
            const match=/^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(line);
            if(!match||!safeName(match[3]))throw fail('IMPACT_GIT_UNAVAILABLE');
            baseline.set(match[3],{mode:match[1],oid:match[2]});
        }
        for(const line of await readNames(['ls-files','--stage','-z'])){
            const match=/^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(line);
            if(!match||match[3]!=='0'||!safeName(match[4]))throw fail('IMPACT_GIT_UNAVAILABLE');
            index.set(match[4],{mode:match[1],oid:match[2]});
        }
        const untracked=new Set(await readNames(['ls-files','--others','--exclude-standard','-z']));
        if([...untracked].some(name=>!safeName(name)))throw fail('IMPACT_GIT_UNAVAILABLE');
        const names=new Set([...baseline.keys(),...index.keys(),...untracked]);if(names.size>maxPaths)throw fail('IMPACT_INPUT_LIMIT');
        const changed=new Set(untracked);let totalBytes=0;
        for(const name of names){
            cancelled(signal);const old=baseline.get(name),staged=index.get(name),current=snapshot.records[name];
            if(old?.oid!==staged?.oid||old?.mode!==staged?.mode)changed.add(name);
            if(!current){if(staged||untracked.has(name))throw fail('IMPACT_GIT_UNAVAILABLE');continue;}
            if(current.state==='deleted'){if(old||staged)changed.add(name);continue;}
            if(staged&&!['100644','100755'].includes(staged.mode)||old&&!['100644','100755'].includes(old.mode))throw fail('IMPACT_GIT_UNAVAILABLE');
            const {bytes,executable}=await regularBytes(root,name);totalBytes+=bytes.length;
            if(totalBytes>bounds.totalBytes)throw fail('IMPACT_INPUT_LIMIT');
            if(hash(bytes)!==current.sha256||executable!==current.executable)throw fail('IMPACT_SOURCE_CHANGED');
            const oid=createHash(baseRevision.length===64?'sha256':'sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
            if(oid!==old?.oid||(executable?'100755':'100644')!==old?.mode)changed.add(name);
        }
        const paths=[...changed].sort();
        if(Buffer.byteLength(paths.join('\0'))>maxGitBytes)throw fail('IMPACT_INPUT_LIMIT');
        return {status:'known',paths,count:paths.length,sha256:hash(JSON.stringify(paths)),unsafe:false};
    }catch(error){if(error.code==='IMPACT_CANCELLED'||error.code==='IMPACT_SOURCE_CHANGED')throw error;
        if(error.code==='SOURCE_CHANGED')throw fail('IMPACT_SOURCE_CHANGED');
        return {status:'unknown',paths:[],count:null,sha256:null,reason:error.code==='IMPACT_INPUT_LIMIT'?'INPUT_LIMIT':'GIT_UNAVAILABLE'};}
}

function select(changed,source){
    const selected=new Set(),reasons=new Map();let fallback=false;
    const reason=(rule,packageId)=>{const key=rule+':'+(packageId??'');const entry=reasons.get(key)??{rule,...(packageId?{package:packageId}:{}),count:0};entry.count++;reasons.set(key,entry);};
    if(source.status==='unknown'){fallback=true;reason('SOURCE_UNKNOWN');}
    if(changed.status==='unknown'){fallback=true;reason('CHANGES_UNKNOWN');}
    if(changed.unsafe){fallback=true;reason('UNSAFE_PATH');}
    if(changed.status==='known'&&!changed.count){fallback=true;reason('NO_CHANGES');}
    for(const name of changed.paths){
        if(!safeName(name))continue;
        let rule;
        if(name.startsWith('services/shared/'))rule='SHARED_INPUT';
        else if(name.startsWith('scripts/workspace/'))rule='PLANNER_INPUT';
        else if(!name.includes('/')||/^(?:\.github|\.codex|\.opencode|docker)\//.test(name))rule='GLOBAL_CONFIGURATION';
        if(rule){fallback=true;reason(rule);continue;}
        const owner=workspacePackages.find(directory=>name.startsWith(directory+'/'));
        if(owner){selected.add(id(owner));reason('PACKAGE_OWNER',id(owner));}
        else if(name.startsWith('scripts/catalog-plugins/')){selected.add('catalog-service');selected.add('bridge');reason('CATALOG_BUILDER','catalog-service');}
        else{fallback=true;reason('UNKNOWN_PATH');}
    }
    for(const packageId of selected)for(const consumer of consumers[packageId]??[])if(!selected.has(consumer)){
        selected.add(consumer);reason('VERIFIED_CONSUMER',consumer);
    }
    return {mode:fallback?'fallback':'scoped',packages:fallback?[...packages]:packages.filter(packageId=>selected.has(packageId)),reasons:[...reasons.values()]};
}

/** Preflight only fixed planner inputs with byte/path bounds, then reuse its exact manifest/discovery capture. */
async function capturePlan(root,selection,signal){
    const selected=selection.packages.length?selection.packages:packages,files=new Map(),directoryEntries=new Map();let bytes=0,discoveryCount=0;
    const read=async name=>{cancelled(signal);const value=(await regularBytes(root,name,1024**2)).bytes;bytes+=value.length;
        if(bytes>maxPlanBytes||files.size>=maxPaths)throw fail('IMPACT_INPUT_LIMIT');files.set(name,value);};
    try{
        for(const packageId of selected)await read(directories.get(packageId)+'/package.json');
        if(!selection.packages.length)for(const directory of discovery){
            if(await fs.realpath(path.join(root,directory))!==path.join(root,directory))throw fail('IMPACT_PLAN_UNAVAILABLE');
            const entries=[],handle=await fs.opendir(path.join(root,directory),{bufferSize:1});
            try{while(true){cancelled(signal);const entry=await handle.read();if(!entry)break;
                entries.push(entry.name);if(++discoveryCount>maxPaths)throw fail('IMPACT_INPUT_LIMIT');}}
            finally{await handle.close();}
            directoryEntries.set(directory,entries.sort());
            for(const name of entries)if(/\.(?:mjs|cjs)$/.test(name))await read(directory+'/'+name);
        }
        const captured=captureCheckPlan(root,selection,{readFileBytes:name=>{
            if(!files.has(name))throw fail('IMPACT_PLAN_UNAVAILABLE');return files.get(name);
        },readDirectory:name=>{if(!directoryEntries.has(name))throw fail('IMPACT_PLAN_UNAVAILABLE');return directoryEntries.get(name);}});
        const inputs=Object.fromEntries([...files].map(([name,value])=>[name,hash(value)]));
        if(JSON.stringify(sortedObject(captured.inputs))!==JSON.stringify(sortedObject(inputs)))throw fail('IMPACT_SOURCE_CHANGED');
        for(const [name,value]of files){let current;try{current=await regularBytes(root,name,1024**2);}catch{throw fail('IMPACT_SOURCE_CHANGED');}
            if(hash(current.bytes)!==hash(value))throw fail('IMPACT_SOURCE_CHANGED');}
        const missingTests=selected.filter(packageId=>!JSON.parse(files.get(directories.get(packageId)+'/package.json').toString('utf8')).scripts?.test);
        return {captured,missingTests};
    }catch(error){if(['IMPACT_CANCELLED','IMPACT_SOURCE_CHANGED','IMPACT_INPUT_LIMIT'].includes(error.code))throw error;throw fail('IMPACT_PLAN_UNAVAILABLE');}
}

function fingerprint(capture){
    const value=capture.snapshot;
    if(!value||Object.keys(value.excluded).length)return {status:'unknown',head:value?.head??null,sha256:null,fileCount:value?.files??null,
        reason:capture.reason??'SOURCE_EXCLUDED_INPUTS'};
    return {status:'known',head:value.head,sha256:value.digest,fileCount:value.files,reason:null};
}

/** Summaries contain only fixed check identifiers; npm scripts and untrusted discovery names stay private. */
function publicChecks(captured,selection){
    const checks=captured.steps.map(step=>{
        if(step.type==='npm')return {kind:'npm',package:id(step.directory),check:step.args[1]};
        if(step.type==='compose')return {kind:'compose',package:null,check:step.args.includes('compose.embedding.yml')?'compose-embeddings':'compose-dev'};
        return {kind:'node',package:null,check:step.nodeTests?'common-contracts':'agent-kit'};
    });
    return {selection,checks,inputsCount:Object.keys(captured.inputs).length,
        inputsSha256:hash(JSON.stringify(sortedObject(captured.inputs))),checksSha256:hash(JSON.stringify(captured.steps))};
}

function additional(changed,missingTests){
    const counts=new Map(),add=kind=>counts.set(kind,(counts.get(kind)??0)+1);
    for(const name of changed.paths){
        if(/(?:^|\/)migrations?(?:\/|\.)|\.sql$/i.test(name))add('database-migrations');
        if(/(?:^|[/-])native(?:[/.\-]|$)|^scripts\/qa\/|^mcp\/neurocenter-asset-sync\//i.test(name))add('native-runtime');
        if(/(?:^|[/-])rag/i.test(name))add('rag-integration');
    }
    return [...counts].map(([kind,count])=>({kind,count,reason:'OUTSIDE_DEFAULT_CHECK'}))
        .concat(missingTests.map(packageId=>({kind:'package-tests-unavailable',package:packageId,count:1,reason:'NO_PACKAGE_TEST_SCRIPT'})));
}

async function build(root,baseRevision,{signal}={}){
    await admit(root,baseRevision,signal);
    const before=await captureCheckSource(root,{signal});cancelled(signal);
    if(before.reason==='SOURCE_CHANGED')throw fail('IMPACT_SOURCE_CHANGED');
    const changed=await changes(root,baseRevision,before.snapshot,signal),sourceFingerprint=fingerprint(before),selection=select(changed,sourceFingerprint);
    const options={packages:selection.mode==='fallback'?[]:selection.packages,steps:[]};
    const {captured,missingTests}=await capturePlan(root,options,signal),changedAfter=await changes(root,baseRevision,before.snapshot,signal);
    const after=await captureCheckSource(root,{signal});cancelled(signal);
    if(after.reason==='SOURCE_CHANGED'||before.snapshot&&after.snapshot&&!sameSource(before.snapshot,after.snapshot)
        ||JSON.stringify(fingerprint(after))!==JSON.stringify(sourceFingerprint)
        ||JSON.stringify(changedAfter)!==JSON.stringify(changed))throw fail('IMPACT_SOURCE_CHANGED');
    const result={schemaVersion:1,baseRevision,sourceFingerprint,changedPathsStatus:changed.status,changedPathsDigest:changed.sha256,
        changedPathsCount:changed.count,...(changed.reason?{changedPathsReason:changed.reason}:{}),...selection,
        plannedChecks:publicChecks(captured,options),additionalAcceptance:additional(changed,missingTests),
        limits:['Read-only impact rules are conservative and are not a complete runtime or API dependency graph.',
            'No checks, writes, installations, network requests or coverage measurements were executed.',
            'Source identity covers retained current bytes; excluded configuration and dependency contents are not frozen.',
            'The 30s cooperative deadline and 5s Git child timeouts do not interrupt a synchronous filesystem operation.',
            'Default check does not establish migration, native, RAG, browser, deployment or production acceptance.']};
    return {...result,planFingerprint:hash(JSON.stringify(result))};
}

/** Bound new observations and pass cancellation through the reused source capture and every Git child. */
async function observe(root,baseRevision,{signal}={}){
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),deadlineMs);
    timer.unref();
    try{return await build(root,baseRevision,{signal:signal?AbortSignal.any([signal,deadline.signal]):deadline.signal});}
    catch(error){if(deadline.signal.aborted&&!signal?.aborted)throw fail('IMPACT_TIMEOUT');throw error;}
    finally{clearTimeout(timer);}
}

/** Plan from one exact local commit; unknown capture chooses full fallback and retains uncertainty. */
export async function planImpact(root,options,{signal}={}){
    const flag=process.env.NEUROCENTER_IMPACT_PLAN;
    if(flag!==undefined&&!['0','1'].includes(flag))throw fail('IMPACT_INVALID_FLAG');
    if(flag==='0')throw fail('IMPACT_DISABLED');
    if(!object(options)||Object.keys(options).some(key=>key!=='baseRevision'))throw fail('IMPACT_INVALID_BASE');
    return observe(root,options.baseRevision,{signal});
}

/** Re-observe source, changed names and exact planner inputs; historical unknown is never called current. */
export async function verifyImpactCurrent(root,plan){
    if(!object(plan)||plan.schemaVersion!==1||!exactRevision(plan.baseRevision)||plan.sourceFingerprint?.status!=='known'
        ||plan.changedPathsStatus!=='known')throw fail('IMPACT_PLAN_UNVERIFIABLE');
    const {planFingerprint,...content}=plan;
    if(hash(JSON.stringify(content))!==planFingerprint)throw fail('IMPACT_PLAN_STALE');
    try{const current=await observe(root,plan.baseRevision);
        if(current.sourceFingerprint.status!=='known'||current.planFingerprint!==planFingerprint)throw fail('IMPACT_PLAN_STALE');
        return {current:true,planFingerprint};
    }catch{throw fail('IMPACT_PLAN_STALE');}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const args=process.argv.slice(2),controller=new AbortController(),stop=()=>controller.abort();
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{
        if(args.length===1&&['--help','-h'].includes(args[0]))process.stdout.write(help);
        else if(args.length===2&&args[0]==='--base')process.stdout.write(JSON.stringify(await planImpact(process.cwd(),{baseRevision:args[1]},{signal:controller.signal}),null,2)+'\n');
        else throw fail('IMPACT_INVALID_ARGUMENT');
    }catch(error){process.stderr.write((/^IMPACT_[A-Z_]+$/.test(error.code)?error.code:'IMPACT_PLAN_UNAVAILABLE')+'\n');process.exitCode=1;}
    finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
