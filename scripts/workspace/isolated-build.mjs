import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {nodeRuntime,npmCli} from './node-runtime.mjs';
import {buildPackages,bounds,BuildError,regularBytes,sourceSnapshot,sameSource,candidateInputs,artifactTree,linkDependencies,dependencyLinksCurrent} from './isolated-build-source.mjs';
import {runBuildProcess,buildLogIdentity} from './isolated-build-process.mjs';

const workspace=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const usage='Usage: node scripts/workspace/isolated-build.mjs (--package <id> | --all) [--plan]\nPackages: '+buildPackages.map(([id])=>id).join(', ')+'\nRequires Node24 and existing dependencies. --help and --plan do not write or build.\n';
const limitations=[
    'Current Git-tracked and nonignored untracked regular files; tracked deletions are retained in the input manifest.',
    'Active dotenv, sensitive named paths, npm/user config, dependencies, Git metadata and generated/local outputs are excluded explicitly.',
    'Existing dependencies are linked, not physically isolated or content-frozen. Trusted build scripts are not a security sandbox; offline npm is not a network firewall.',
    'Candidate outputs stay in the retained run. No outputs are published or copied to live dist; no dependency installation is performed.',
    'This is a local compilation check, not runtime/test/production acceptance. Native process lifecycle is currently verified only on macOS.',
];

/** Fixed package selection; caller paths, shell commands and dependency installation are not options. */
export function parseBuildArguments(args){
    if(args.length===1&&args[0]==='--help')return {help:true};
    let all=false,id,plan=false;
    for(let index=0;index<args.length;index++){
        const option=args[index];
        if(option==='--all'&&!all)all=true;
        else if(option==='--plan'&&!plan)plan=true;
        else if(option==='--package'&&id===undefined)id=args[++index];
        else throw new BuildError('INVALID_ARGUMENT',usage.trim());
    }
    if(all===(id!==undefined)||!all&&!buildPackages.some(([name])=>name===id))throw new BuildError('INVALID_ARGUMENT',usage.trim());
    return {selection:buildPackages.filter(([name])=>all||name===id),plan};
}

async function manifest(root,relative){return JSON.parse((await regularBytes(root,relative,65536)).bytes.toString('utf8'));}
async function validateRoot(root){if(await fs.realpath(root)!==root||(await manifest(root,'package.json')).name!=='neurocenter-workspace')throw new BuildError('WORKSPACE_INVALID','Use an intact canonical neurocenter-workspace checkout.');}

/** Read-only plan uses no runtime subprocess, output directory, install or build. */
export async function isolatedBuildPlan(root,selection){
    if(!Array.isArray(selection)||!selection.length||selection.length>buildPackages.length||new Set(selection.map(item=>item?.[0])).size!==selection.length
        ||selection.some(item=>!buildPackages.some(known=>JSON.stringify(known)===JSON.stringify(item))))throw new BuildError('INVALID_ARGUMENT','Choose canonical package IDs from --help.');
    await validateRoot(root);const packages=[];
    for(const [id,folder,entry]of selection){const value=await manifest(root,folder+'/package.json');if(typeof value.scripts?.build!=='string'||!value.scripts.build.trim())throw new BuildError('BUILD_SCRIPT_MISSING','A selected package has no build script.');packages.push({id,path:folder,version:value.version,requiredEntry:'dist/'+entry,command:'npm run build'+(id==='frontend'?' -- --configLoader runner':'')});}
    return {mode:'plan',packages,inputScope:'git cached + nonignored untracked, current bytes including dirty/new/deleted files',bounds,timeoutMsPerPackage:180000,requiresNode:24,currentNode:process.version,limitations};
}

async function checkedDirectory(folder){
    try{await fs.mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await fs.lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(folder)!==folder)throw new BuildError('UNSAFE_OUTPUT','The isolated build output path must not contain links.');
}
async function save(folder,name,value){await fs.writeFile(path.join(folder,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function liveOutputs(root){return Object.fromEntries(await Promise.all(buildPackages.map(async([id,folder])=>[id,await artifactTree(path.join(root,folder,'dist'))])));}
function failure(error){return {code:error instanceof BuildError?error.code:['ENOENT','ENOTDIR'].includes(error.code)?'INPUT_UNAVAILABLE':'BUILD_CHECK_FAILED',message:error instanceof BuildError?error.message:'The isolated build could not complete; inspect the retained inputs and private build logs.'};}

async function privateEnvironment(folder,node){
    const home=path.join(folder,'private-home'),temporary=path.join(folder,'temporary'),cache=path.join(folder,'npm-cache');
    for(const directory of[home,temporary,cache])await fs.mkdir(directory,{mode:0o700});
    const userconfig=path.join(folder,'empty-user.npmrc'),globalconfig=path.join(folder,'empty-global.npmrc');
    await fs.writeFile(userconfig,'',{mode:0o600});await fs.writeFile(globalconfig,'',{mode:0o600});
    return {PATH:[path.dirname(node),'/usr/bin','/bin','/usr/sbin','/sbin'].join(path.delimiter),HOME:home,USERPROFILE:home,TMPDIR:temporary,TMP:temporary,TEMP:temporary,
        XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),
        NODE_ENV:'production',CI:'1',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8',
        npm_config_cache:cache,npm_config_userconfig:userconfig,npm_config_globalconfig:globalconfig,npm_config_offline:'true',npm_config_fetch_retries:'0',
        npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false'};
}

/** Build a stable copy of current inputs; keep every failure and artifact in this run without publishing anything. */
export async function isolatedBuild(root,selection,{signal,timeoutMs=180000,graceMs=1000,onCopied,onBuildProcess,buildOwnerFile}={}){
    await isolatedBuildPlan(root,selection);
    if(process.platform==='win32')throw new BuildError('UNSUPPORTED_PLATFORM','This process-group implementation currently requires POSIX.');
    const cleanPath=[path.dirname(process.execPath),'/usr/bin','/bin','/usr/sbin','/sbin'].join(path.delimiter);
    const runtime=nodeRuntime({NODE_BIN:process.execPath,PATH:cleanPath}),npm=npmCli({PATH:cleanPath});
    await checkedDirectory(path.join(root,'.run'));await checkedDirectory(path.join(root,'.run/isolated-build'));
    const folder=path.join(root,'.run/isolated-build',randomUUID());await fs.mkdir(folder,{mode:0o700});
    const repository=path.join(folder,'repository');await fs.mkdir(repository,{mode:0o700});
    const receipt={schemaVersion:1,id:path.basename(folder),startedAt:new Date().toISOString(),ok:false,status:'preparing',node:runtime.version,platform:process.platform,arch:process.arch,
        selectedPackages:selection.map(([id])=>id),repository,builds:[],limitations,inputs:null,sourceCurrent:null,liveOutputsUnchanged:null,dependencyLinksUnchanged:null};
    let initial,links,liveBefore,primary;
    try{
        const environment=await privateEnvironment(folder,runtime.node);receipt.environmentKeys=Object.keys(environment).sort();
        initial=await sourceSnapshot(root,{signal});await save(folder,'source-before.json',initial);
        const copied=await sourceSnapshot(root,{destination:repository,onCopied,signal});await save(folder,'source-copied.json',copied);
        const current=await sourceSnapshot(root,{signal});await save(folder,'source-after-copy.json',current);
        if(!sameSource(initial,copied)||!sameSource(copied,current))throw new BuildError('SOURCE_CHANGED','Current inputs changed during snapshot; no compiler was launched.');
        const candidate=await candidateInputs(repository,copied);await save(folder,'candidate-inputs-before.json',candidate);
        if(!candidate.ok)throw new BuildError('CANDIDATE_CHANGED','Copied source does not match the input hashes; no compiler was launched.');
        receipt.inputs={head:copied.head,sha256:copied.digest,files:copied.files,bytes:copied.bytes,newFiles:copied.newFiles,deleted:copied.deleted,exclusions:Object.keys(copied.excluded).length};
        links=await linkDependencies(root,repository,selection);await save(folder,'dependency-links.json',links);
        liveBefore=await liveOutputs(root);await save(folder,'live-dist-before.json',liveBefore);
        if(!await dependencyLinksCurrent(root,repository,links))throw new BuildError('DEPENDENCIES_CHANGED','Dependency link identity changed before launch.');
        const launchSource=await sourceSnapshot(root,{signal});await save(folder,'source-at-launch.json',launchSource);
        if(!sameSource(copied,launchSource))throw new BuildError('SOURCE_CHANGED','Current inputs changed before launch; retry after edits settle.');
        receipt.status='building';await save(folder,'receipt.json',receipt);
        for(const [id,relative,entry]of selection){
            if(signal?.aborted)throw new BuildError('CANCELLED','The isolated build was cancelled.');
            if(!await dependencyLinksCurrent(root,repository,links))throw new BuildError('DEPENDENCIES_CHANGED','Dependency link identity changed between builds.');
            const args=[npm,'run','build',...id==='frontend'?['--','--configLoader','runner']:[]],logFile=path.join(folder,id+'.log');
            const result=await runBuildProcess({node:runtime.node,args,cwd:path.join(repository,relative),env:environment,logFile,signal,timeoutMs,graceMs,onSpawn:onBuildProcess,ownerFile:buildOwnerFile});
            result.id=id;result.command=[runtime.node,...args];result.log={path:path.relative(root,logFile)};
            receipt.builds.push(result);
            if(!result.ok)primary??=result.failure||{code:'BUILD_FAILED'};
            try{Object.assign(result.log,await buildLogIdentity(logFile));if(result.log.bytes>32*1024**2){result.ok=false;result.failure??={code:'BUILD_LOG_LIMIT'};}}
            catch{result.ok=false;result.log.error={code:'LOG_READ_FAILED'};result.failure??={code:'LOG_READ_FAILED'};}
            try{const artifacts=await artifactTree(path.join(repository,relative,'dist'));await save(folder,id+'-artifacts.json',artifacts);result.artifacts={files:Object.keys(artifacts.files).length,bytes:artifacts.bytes,sha256:artifacts.digest,requiredEntry:entry,requiredEntryPresent:Object.hasOwn(artifacts.files,entry)};
                if(!result.artifacts.requiredEntryPresent){result.ok=false;result.failure??={code:'MISSING_ENTRY'};}}
            catch(error){result.ok=false;result.failure??=failure(error);}
            await save(folder,'receipt.json',receipt);
            if(!result.ok){primary??=result.failure||{code:'BUILD_FAILED'};break;}
        }
    }catch(error){primary??=failure(error);}
    const finishErrors=[];
    if(initial)try{const after=await sourceSnapshot(root);await save(folder,'source-after-build.json',after);receipt.sourceCurrent=sameSource(initial,after);if(!receipt.sourceCurrent)finishErrors.push({code:'SOURCE_CHANGED_AFTER_SNAPSHOT'});}catch(error){receipt.sourceCurrent=false;finishErrors.push(failure(error));}
    if(initial)try{const candidate=await candidateInputs(repository,initial);await save(folder,'candidate-inputs-after.json',candidate);receipt.candidateInputsUnchanged=candidate.ok;if(!candidate.ok)finishErrors.push({code:'CANDIDATE_CHANGED'});}catch(error){receipt.candidateInputsUnchanged=false;finishErrors.push(failure(error));}
    if(liveBefore)try{const after=await liveOutputs(root);await save(folder,'live-dist-after.json',after);receipt.liveOutputsUnchanged=JSON.stringify(liveBefore)===JSON.stringify(after);if(!receipt.liveOutputsUnchanged)finishErrors.push({code:'LIVE_OUTPUT_CHANGED'});}catch(error){receipt.liveOutputsUnchanged=false;finishErrors.push(failure(error));}
    if(links){receipt.dependencyLinksUnchanged=await dependencyLinksCurrent(root,repository,links);if(!receipt.dependencyLinksUnchanged)finishErrors.push({code:'DEPENDENCIES_CHANGED'});}
    receipt.finishedAt=new Date().toISOString();receipt.primaryFailure=primary||finishErrors[0]||null;receipt.finalizationErrors=finishErrors;
    receipt.ok=!receipt.primaryFailure&&receipt.builds.length===selection.length&&receipt.builds.every(result=>result.ok)&&receipt.sourceCurrent===true
        &&receipt.candidateInputsUnchanged===true&&receipt.liveOutputsUnchanged===true&&receipt.dependencyLinksUnchanged===true;
    receipt.status=receipt.ok?'built-current-snapshot':receipt.primaryFailure?.code==='CANCELLED'?'cancelled':'failed';
    await save(folder,'receipt.json',receipt);return {...receipt,receipt:path.join(folder,'receipt.json')};
}

export async function main(args,{root=workspace,output=process.stdout}={}){
    const parsed=parseBuildArguments(args);if(parsed.help){output.write(usage);return 0;}
    if(parsed.plan){output.write(JSON.stringify(await isolatedBuildPlan(root,parsed.selection),null,2)+'\n');return 0;}
    const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
    try{const result=await isolatedBuild(root,parsed.selection,{signal:controller.signal});output.write(JSON.stringify({ok:result.ok,status:result.status,selected:result.selectedPackages,built:result.builds.length,receipt:result.receipt,primaryFailure:result.primaryFailure})+'\n');return result.ok?0:result.status==='cancelled'?130:1;}
    finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)try{process.exitCode=await main(process.argv.slice(2));}catch(error){process.stderr.write((error instanceof BuildError?error.message:'Cannot prepare isolated build. Check Node24, current source and existing dependencies.')+'\n');process.exitCode=1;}
