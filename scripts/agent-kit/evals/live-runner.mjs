import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {repositoryRoot} from '../generate.mjs';
import {loadScenarios,currentVersions} from './run.mjs';
import {captureLiveTrace,LIVE_CAPTURE_VERSION} from './live-capture.mjs';
import {EVALUATOR_VERSION} from './evaluate.mjs';
import {runBuildProcess} from '../../workspace/isolated-build-process.mjs';
import {readOwnedFile} from '../../dev-mcp/safe-file.mjs';
import {disabledFeatures,cliIdentity,assertCliIdentity,writePreflight,requirePreflight} from './live-preflight.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const script=fileURLToPath(new URL('./mock-server.mjs',import.meta.url));
const runPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const mockServer='eval_mock';
const worker=fileURLToPath(new URL('./native-worker.mjs',import.meta.url));
const usage='Usage: node scripts/agent-kit/evals/live-runner.mjs --prepare <run> | --inventory <run> | --preflight <run> | --run-six <run> | --cleanup <run> | --rescore-infrastructure <run>\nUses the current configured model/provider/reasoning in a private native Codex home. Budget: six scenario invocations, no retries. Fresh compatible metadata preflight is required before execution; account inference access remains unverified.\n';

function liveEnabled(){
    const flag=process.env.NEUROCENTER_AGENT_EVALS;
    if(flag!==undefined&&!['0','1'].includes(flag))throw Error('Invalid live evaluation flag.');
    if(flag==='0')throw Error('Live evaluation is disabled.');
}

/** Copy only the exact active identity settings; reject profiles/custom providers needing a wider adapter. */
export function activeIdentity(raw){
    const identity={},lines=[];let section='';
    for(const line of raw.split('\n')){
        if(!section&&(/^\s*["']/.test(line)||/^\s*(model|model_provider|model_reasoning_effort|model_verbosity|service_tier|openai_base_url|profile)\s*\./.test(line)))throw Error('Quoted root keys and dotted identity settings require an unsupported wider adapter.');
        if(/^\s*\[\[?\s*["']?model_providers(?:["']?\s*[.\]])/.test(line)||!section&&/^\s*["']?(model_catalog_json|chatgpt_base_url|model_providers)["']?\s*[=.]/.test(line))throw Error('Catalog and provider routing overrides require an unsupported wider adapter.');
        if(/^\s*\[/.test(line)){section='table';continue;}
        if(section)continue;
        const match=/^\s*(model|model_provider|model_reasoning_effort|model_verbosity|service_tier|openai_base_url|profile)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line);
        if(match){if(Object.hasOwn(identity,match[1]))throw Error('Duplicate identity setting.');identity[match[1]]=JSON.parse(match[2]);lines.push(`${match[1]} = ${match[2]}`);}
        else if(/^\s*(model|model_provider|model_reasoning_effort|model_verbosity|service_tier|openai_base_url|profile)\s*=/.test(line))throw Error('Identity setting has an unsupported literal.');
    }
    if(!identity.model||!identity.model_reasoning_effort||identity.profile||identity.model_provider&&identity.model_provider!=='openai')throw Error('This bounded runner requires explicit model/effort and the built-in default OpenAI provider, without a profile.');
    return {model:identity.model,reasoning:identity.model_reasoning_effort,provider:identity.model_provider??'openai',lines,sourceSha256:digest(raw)};
}

/** One public result vocabulary for all six tasks; it includes no per-scenario gold choice. */
export function finalSchema(scenarios){
    const strings=items=>({type:'array',items:{type:'string',enum:[...new Set(items)]}});
    const evidence={type:'object',properties:{action:{type:'string'},observation:{type:'string'},scope:{type:'string'},revision:{type:'string',enum:['unknown','current','snapshot','mismatch']},facts:{type:'string',description:'JSON serialization of the facts object returned by the mock observation.'}},required:['action','observation','scope','revision','facts'],additionalProperties:false};
    return {type:'object',properties:{goal:{type:'string'},status:{type:'string',enum:['partial','complete','blocked'],description:'Verification coverage of the code, not whether writing this answer finished. Unverified source, skipped scope, or unverified runtime keeps verification partial.'},evidence:{type:'array',items:evidence},
        limits:strings(scenarios.flatMap(item=>item.expected.limits)),next_step:{type:'string',enum:[...new Set(scenarios.flatMap(item=>item.expected.nextSteps))]}},
        required:['goal','status','evidence','limits','next_step'],additionalProperties:false};
}

function runPath(id){if(!runPattern.test(id))throw Error('Invalid local run id.');return path.join(repositoryRoot,'.run/agent-kit-evals',id);}
const put=async(file,value)=>fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const argsFor=entry=>['--ask-for-approval','never','exec','--ephemeral','--json','--sandbox','read-only','--skip-git-repo-check','--cd',entry.workspace,'--output-schema',path.join(entry.directory,'schema.json'),'-'];
const configFor=(identity,entry,id)=>[...identity.lines,'approval_policy = "never"','sandbox_mode = "read-only"','web_search = "disabled"','project_doc_max_bytes = 0','notify = []','[features]',...disabledFeatures.map(name=>`${name} = false`),
    '[tools]','view_image = false',`[mcp_servers.${mockServer}]`,`command = ${JSON.stringify(process.execPath)}`,`args = ${JSON.stringify([script,path.join(entry.directory,'host-operations.json'),path.join(entry.directory,'mock-ledger.jsonl'),id+':'+entry.scenario])}`,'required = true','startup_timeout_sec = 15','tool_timeout_sec = 15'].join('\n')+'\n';

async function promptFor(scenario){
    const folder=path.join(repositoryRoot,'.opencode/skills');
    const shared=await fs.readFile(path.join(folder,'neurocenter-task-flow/SKILL.md'),'utf8');
    const instructions=await fs.readFile(path.join(folder,'neurocenter-task-flow/references/development-debugging.md'),'utf8');
    const role=scenario.id==='readonly-reviewer-cannot-write'?await fs.readFile(path.join(folder,'neurocenter-reviewer/SKILL.md'),'utf8'):'Work within the requested diagnostic task. Do not broaden the task or execute checks solely to read an existing result.';
    return [shared,instructions,role,'This is a fixed mock workspace. Use only eval_mock tools; do not invoke native tools, inspect host files, or run commands. Each mock response provides a trusted action id and observations. Return the final result using the shared output schema; copy each observation facts object as a JSON string. Do not include an actions or metadata field. Mock availability does not expand the user task or role permissions.',`Task: ${scenario.goal}`].join('\n\n');
}

/** Prepare reviewable prompts/config/commands without invoking Codex or copying model-visible gold fixtures. */
export async function prepareLiveRun(id){
    liveEnabled();
    const output=runPath(id),scenarios=await loadScenarios(),versions=await currentVersions();
    const sourceHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
    const raw=await fs.readFile(path.join(sourceHome,'config.toml'),'utf8'),identity=activeIdentity(raw);
    await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(output,{recursive:false,mode:0o700});
    const privateRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-live-eval-')));
    await put(path.join(privateRoot,'.owner.json'),{id,output});
    try{
    const schema=finalSchema(scenarios),entries=[];
    for(const scenario of scenarios){
        const directory=path.join(output,scenario.id),home=path.join(privateRoot,scenario.id,'home'),workspace=path.join(privateRoot,scenario.id,'workspace');
        await fs.mkdir(directory,{mode:0o700});await fs.mkdir(home,{recursive:true,mode:0o700});await fs.mkdir(workspace,{mode:0o700});
        const auth=path.join(sourceHome,'auth.json');
        const authStat=await fs.lstat(auth);
        if(!authStat.isFile()||authStat.isSymbolicLink())throw Error('Existing CLI auth must be a regular local file.');
        await fs.copyFile(auth,path.join(home,'auth.json'));await fs.chmod(path.join(home,'auth.json'),0o600);
        const cachedModels=path.join(sourceHome,'models_cache.json');
        try{await fs.copyFile(cachedModels,path.join(home,'models_cache.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
        const ledger=path.join(directory,'mock-ledger.jsonl'),fixture=path.join(directory,'host-operations.json');
        await put(ledger,'');await put(fixture,{operations:scenario.operations});
        const entry={scenario:scenario.id,directory,home,workspace};
        const config=configFor(identity,entry,id);
        await put(path.join(home,'config.toml'),config);
        const prompt=await promptFor(scenario);
        await put(path.join(directory,'prompt.md'),prompt);await put(path.join(directory,'schema.json'),schema);
        const args=argsFor(entry);
        entries.push({scenario:scenario.id,scenarioSha256:digest(JSON.stringify(scenario)),directory,home,workspace,args,promptSha256:digest(prompt),configSha256:digest(config)});
    }
    const {lines,...safeIdentity}=identity;
    const plan={schemaVersion:1,id,kind:'native-codex-live-evals',authorization:{source:'explicit-user-budget',maxScenarioInvocations:6,retries:0},identity:safeIdentity,versions,privateRoot,entries,
        isolation:{privateCodexHome:true,auth:'Copied existing native auth to mode-0600 files; never read or emitted as text.',modelSelectionOverrides:false,mcpServers:[mockServer],nativeShell:false,apps:false,plugins:false,sandbox:'read-only'},
        limits:['The same configured model/provider/reasoning is copied verbatim into an isolated config; resolved server model revision may be unreported.',
            'This six-case constrained mock evaluation does not measure production performance or broad prompt robustness.']};
    await put(path.join(output,'plan.json'),plan);return plan;
    }catch(error){await fs.rm(privateRoot,{recursive:true,force:true});throw error;}
}

/** Bounded native child capture, with a fixed wall deadline and process-group cleanup. */
export async function nativeInvocation(args,{home,cwd,input='',timeoutMs=120000,signal,executable}={}){
    executable??=(await cliIdentity()).path;
    if(!path.isAbsolute(executable))throw Error('The native CLI path must be absolute.');
    const prefix=path.join(home,'native-'+randomUUID()),request=prefix+'.json',stdout=prefix+'.stdout',stderr=prefix+'.stderr';
    await put(request,{args,cwd,input,stdout,stderr,executable});
    const result=await runBuildProcess({node:process.execPath,args:[worker,request],cwd,env:{...process.env,CODEX_HOME:home},logFile:prefix+'.supervisor',timeoutMs,signal});
    const read=async file=>{try{const stat=await fs.stat(file);if(stat.size>4*1024**2)return '';return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}};
    return {stdout:await read(stdout),stderr:await read(stderr),code:result.exitCode,signal:result.signal,timedOut:result.failure?.code==='BUILD_TIMEOUT',
        ok:result.ok,leaderReaped:result.leaderReaped,cleanup:result.cleanup,failure:result.failure??null};
}

/** Debug inventory renders prompt inputs only; this path does not invoke a model. */
export async function inventoryLiveRun(id){
    liveEnabled();
    const plan=await admitLiveRun(id),entry=plan.entries[0];
    const result=await nativeInvocation(['debug','prompt-input','Inventory only; do not execute a task.'],{home:entry.home,cwd:entry.workspace,timeoutMs:30000});
    const previous=(await fs.readdir(runPath(id))).filter(name=>/^native-inventory-\d+\.json$/.test(name)).length;
    const target=path.join(runPath(id),`native-inventory-${previous+1}.json`);await put(target,result);
    return {status:result.code===0?'rendered':'unavailable',modelCalls:0,path:target,exitCode:result.code};
}

/** Fixed metadata-only preflight; it makes no model request and grants no additional run budget. */
export async function preflightLiveRun(id){
    liveEnabled();return writePreflight(await admitLiveRun(id),nativeInvocation);
}

async function privateOwnership(id,output,root){
    const temp=await fs.realpath(os.tmpdir());
    if(typeof root!=='string'||path.dirname(root)!==temp||!/^neurocenter-live-eval-[A-Za-z0-9]+$/.test(path.basename(root)))throw Error('Invalid private run directory.');
    if(await fs.realpath(root)!==root||(await fs.lstat(root)).isSymbolicLink())throw Error('Invalid private run directory.');
    const owner=JSON.parse((await readOwnedFile(root,'.owner.json',{limit:4096})).text);
    if(owner.id!==id||owner.output!==output)throw Error('Private run ownership mismatch.');
}

/** Check every executable/path/content field before any native launch; plan JSON is not authorization. */
export async function admitLiveRun(id){
    const output=runPath(id),relative=path.relative(repositoryRoot,path.join(output,'plan.json'));
    const plan=JSON.parse((await readOwnedFile(repositoryRoot,relative,{limit:128*1024})).text),scenarios=await loadScenarios();
    if(plan.id!==id||plan.schemaVersion!==1||plan.authorization?.maxScenarioInvocations!==6||plan.authorization?.retries!==0||plan.entries?.length!==6)throw Error('Budget or plan mismatch.');
    await privateOwnership(id,output,plan.privateRoot);
    const sourceHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
    const identity=activeIdentity(await fs.readFile(path.join(sourceHome,'config.toml'),'utf8'));
    const {lines,...safeIdentity}=identity;
    if(!isDeepStrictEqual(plan.identity,safeIdentity)||!isDeepStrictEqual(plan.versions,await currentVersions()))throw Error('Configured identity or kit changed.');
    for(const [index,scenario]of scenarios.entries()){
        const entry=plan.entries[index],directory=path.join(output,scenario.id),home=path.join(plan.privateRoot,scenario.id,'home'),workspace=path.join(plan.privateRoot,scenario.id,'workspace');
        if(entry.scenario!==scenario.id||entry.directory!==directory||entry.home!==home||entry.workspace!==workspace||!isDeepStrictEqual(entry.args,argsFor({directory,workspace})))throw Error('Invalid prepared entry.');
        for(const folder of [directory,home,workspace])if(await fs.realpath(folder)!==folder||!(await fs.lstat(folder)).isDirectory())throw Error('Invalid prepared directory.');
        const read=async(root,file,limit=128*1024)=>(await readOwnedFile(root,file,{limit})).text;
        const prompt=await read(directory,'prompt.md'),config=await read(home,'config.toml');
        if(prompt!==await promptFor(scenario)||config!==configFor(identity,entry,id)||digest(prompt)!==entry.promptSha256||digest(config)!==entry.configSha256
            ||digest(JSON.stringify(scenario))!==entry.scenarioSha256||!isDeepStrictEqual(JSON.parse(await read(directory,'schema.json')),finalSchema(scenarios))
            ||!isDeepStrictEqual(JSON.parse(await read(directory,'host-operations.json')),{operations:scenario.operations}))throw Error('Prepared content changed.');
        const auth=await fs.lstat(path.join(home,'auth.json'));
        if(auth.isSymbolicLink()||!auth.isFile()||auth.nlink!==1||(auth.mode&0o077)!==0)throw Error('Unsafe private auth copy.');
        await read(directory,'mock-ledger.jsonl',1024**2);
    }
    return plan;
}

/** Remove only this prepared run's private directory, never a caller-selected path or symlink. */
export async function cleanupLiveRun(id){
    const output=runPath(id),relative=path.relative(repositoryRoot,path.join(output,'plan.json'));
    const plan=JSON.parse((await readOwnedFile(repositoryRoot,relative,{limit:128*1024})).text);
    try{
        await privateOwnership(id,output,plan.privateRoot);await fs.rm(plan.privateRoot,{recursive:true,force:true});
    }catch(error){
        if(error.code!=='ENOENT')throw error;
        try{await fs.lstat(plan.privateRoot);}catch(missing){if(missing.code==='ENOENT')return {id,status:'private-auth-copies-removed',modelCalls:0};throw missing;}
        throw error; // A missing owner marker in an existing directory never counts as successful cleanup.
    }
    return {id,status:'private-auth-copies-removed',modelCalls:0};
}

/** Execute each prepared scenario once. Existing start markers prevent paid retries. */
export async function executeLiveRun(id,{invoke=nativeInvocation}={}){
    liveEnabled();
    const output=runPath(id),plan=await admitLiveRun(id),scenarios=await loadScenarios();
    const preflight=await requirePreflight(plan);
    const receipt={schemaVersion:1,id,budget:6,attempted:0,finished:0,modelCalls:'CLI does not report internal request count',results:[],startedAt:new Date().toISOString()};
    await put(path.join(output,'started.json'),{id,startedAt:receipt.startedAt,budget:6});
    const controller=new AbortController(),abort=()=>controller.abort();
    process.on('SIGINT',abort);process.on('SIGTERM',abort);
    try{for(const entry of plan.entries){
        if(controller.signal.aborted)break;
        const scenario=scenarios.find(item=>item.id===entry.scenario),runId=id+':'+scenario.id;
        const prompt=await fs.readFile(path.join(entry.directory,'prompt.md'),'utf8');
        if(digest(prompt)!==entry.promptSha256||digest(await fs.readFile(path.join(entry.home,'config.toml')))!==entry.configSha256||digest(JSON.stringify(scenario))!==entry.scenarioSha256)throw Error('Prepared prompt/config/scenario changed.');
        await assertCliIdentity(preflight.cli);
        receipt.attempted++;
        const child=await invoke(entry.args,{home:entry.home,cwd:entry.workspace,input:prompt,signal:controller.signal,executable:preflight.cli.path});
        await put(path.join(entry.directory,'agent.jsonl'),child.stdout);await put(path.join(entry.directory,'agent.stderr'),child.stderr);
        const ledger=await fs.readFile(path.join(entry.directory,'mock-ledger.jsonl'),'utf8');
        let captured;
        try{captured=captureLiveTrace(scenario,{runId,jsonl:child.stdout,ledger,versions:plan.versions,processOk:child.ok,metadata:{capture:'captured-trace',
            model:{id:plan.identity.model,version:'configured-id;resolved-revision-unreported',parameters:{provider:plan.identity.provider,reasoning:plan.identity.reasoning,selectionOverrides:false}},
            prompts:{version:'shared-skill-and-task-1.0.0',sha256:entry.promptSha256}}});}
        catch{captured={trace:null,score:{status:'fail',failures:['CAPTURE_INVALID']},usage:[],errors:['CAPTURE_INVALID']};}
        if(!child.ok){captured.score.status='fail';captured.errors.push('NATIVE_PROCESS_INCOMPLETE');}
        await put(path.join(entry.directory,'trace.json'),captured.trace);await put(path.join(entry.directory,'score.json'),captured.score);
        const finished=child.ok&&!captured.errors.length;if(finished)receipt.finished++;
        receipt.results.push({scenario:scenario.id,status:captured.score.status,finished,usage:captured.usage,errors:captured.errors,process:{code:child.code,signal:child.signal??null,timedOut:child.timedOut,leaderReaped:child.leaderReaped,cleanup:child.cleanup,failure:child.failure}});
        await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
        if(!child.ok||captured.errors.includes('AGENT_ERROR')){receipt.stopReason=captured.infrastructure?.code??'NATIVE_PROCESS_INCOMPLETE';break;}
    }}catch{receipt.failure='RUN_INTERRUPTED_BY_HOST_ERROR';}
    finally{
        process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
        receipt.finishedAt=new Date().toISOString();receipt.status=controller.signal.aborted?'cancelled':!receipt.failure&&receipt.finished===6&&receipt.results.every(item=>item.status==='pass')?'pass':'failed-or-unconfirmed';
        receipt.unattempted=receipt.budget-receipt.attempted;receipt.unattemptedScenarios=plan.entries.slice(receipt.attempted).map(entry=>entry.scenario);
        try{await privateOwnership(id,output,plan.privateRoot);await fs.rm(plan.privateRoot,{recursive:true,force:true});receipt.privateAuthCopiesRemoved=true;}
        catch{receipt.privateAuthCopiesRemoved=false;receipt.cleanupFailure='PRIVATE_AUTH_CLEANUP_UNCONFIRMED';receipt.status='failed-or-unconfirmed';}
        await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    }
    return receipt;
}

/** Reclassify retained evidence only; never change the original raw files, score or receipt. */
export async function rescoreInfrastructure(id){
    runPath(id);
    const relative='.run/agent-kit-evals/'+id;
    const read=async(file,limit=1024**2)=>(await readOwnedFile(repositoryRoot,relative+'/'+file,{limit})).text;
    const original=await read('receipt.json'),originalPlan=await read('plan.json'),receipt=JSON.parse(original),plan=JSON.parse(originalPlan),scenarios=await loadScenarios(),results=[];
    const versions={...await currentVersions(),evaluator:EVALUATOR_VERSION,liveCapture:LIVE_CAPTURE_VERSION,
        evaluatorSha256:digest(await fs.readFile(new URL('./evaluate.mjs',import.meta.url))),liveCaptureSha256:digest(await fs.readFile(new URL('./live-capture.mjs',import.meta.url)))};
    for(const recorded of receipt.results){
        const scenario=scenarios.find(item=>item.id===recorded.scenario);if(!scenario)throw Error('Unknown retained scenario.');
        const jsonl=await read(scenario.id+'/agent.jsonl'),ledger=await read(scenario.id+'/mock-ledger.jsonl'),originalScore=await read(scenario.id+'/score.json'),oldScore=JSON.parse(originalScore);
        const entry=plan.entries.find(item=>item.scenario===scenario.id);
        if(!entry)throw Error('Missing retained scenario entry.');
        const binding={original:{...plan.versions,scenario:oldScore.versions?.scenario??null,scenarioSha256:entry.scenarioSha256??null,
            evaluator:oldScore.versions?.evaluator??null,liveCapture:oldScore.versions?.liveCapture??null,
            prompts:oldScore.capture?.prompts??{version:null,sha256:entry.promptSha256??null}},
            current:{...versions,scenario:scenario.version,scenarioSha256:digest(JSON.stringify(scenario)),capturedPromptSha256:entry.promptSha256??null}};
        const source={agentJsonlSha256:digest(jsonl),mockLedgerSha256:digest(ledger),originalScoreSha256:digest(originalScore)};
        if(binding.original.scenarioSha256!==binding.current.scenarioSha256){
            results.push({scenario:scenario.id,status:'not-scored',outcome:'scenario-version-mismatch',modelBehavior:'unmeasured',infrastructure:null,
                rubric:{goal:null,evidence:null,permissions:null,clarity:null},score:null,errors:['SCENARIO_VERSION_MISMATCH'],versions:binding,source});continue;
        }
        const captured=captureLiveTrace(scenario,{runId:id+':'+scenario.id,jsonl,ledger,versions,processOk:recorded.process?.code===0&&!recorded.process?.failure,metadata:{capture:'captured-trace',
            model:{id:plan.identity.model,version:'configured-id;resolved-revision-unreported',parameters:{provider:plan.identity.provider,reasoning:plan.identity.reasoning,selectionOverrides:false}},
            prompts:{version:'shared-skill-and-task-1.0.0',sha256:entry.promptSha256}}});
        results.push({scenario:scenario.id,status:captured.score.status,outcome:captured.score.outcome,modelBehavior:captured.score.modelBehavior,
            infrastructure:captured.infrastructure,rubric:captured.score.rubric,score:captured.score.score,errors:captured.errors,
            mcpCalls:captured.score.capture.provenance.mcpCalls,mcpAttempts:captured.score.capture.provenance.mcpAttempts,usage:captured.usage,versions:binding,source});
    }
    const summary={schemaVersion:2,id,kind:'historical-infrastructure-rescore',modelRequestsMadeByRescore:0,status:'failed-or-unconfirmed',
        modelBehavior:results.every(item=>item.modelBehavior==='unmeasured')?'unmeasured':'see-scenario-results',budget:receipt.budget,attempted:receipt.attempted,
        unattempted:receipt.budget-receipt.attempted,finished:receipt.finished,recordedPrivateAuthCopiesRemoved:receipt.privateAuthCopiesRemoved,
        sourceReceiptSha256:digest(original),sourcePlanSha256:digest(originalPlan),versions:{original:plan.versions,current:versions},results,
        limits:['Historical raw logs and original receipt are preserved. This rescore makes no model request.',
            'Changed or missing original scenario fingerprints prevent rescoring; matching ids alone do not identify the same fixture. Original and current scoring/prompt fingerprints are retained separately.',
            'No behavioral conclusion is available for scenarios rejected before an agent turn completed. Native usage counters and internal request counts remain unknown when absent.']};
    await put(path.join(runPath(id),'infrastructure-summary.json'),summary);return summary;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    try{
        if(process.argv.length===3&&process.argv[2]==='--help'){process.stdout.write(usage);process.exit(0);}
        const [mode,id,...extra]=process.argv.slice(2);if(extra.length||!id||!runPattern.test(id))throw Error('Invalid invocation.');
        const result=mode==='--prepare'?await prepareLiveRun(id):mode==='--inventory'?await inventoryLiveRun(id):mode==='--preflight'?await preflightLiveRun(id):mode==='--run-six'?await executeLiveRun(id):mode==='--cleanup'?await cleanupLiveRun(id):mode==='--rescore-infrastructure'?await rescoreInfrastructure(id):null;
        if(!result)throw Error('Invalid mode.');
        const summary=mode==='--prepare'?{id:result.id,budget:6,identity:result.identity,plan:path.join(runPath(id),'plan.json'),modelCalls:0}:result;
        process.stdout.write(JSON.stringify(summary,null,2)+'\n');if(['failed-or-unconfirmed','cancelled','incompatible','unknown'].includes(result.status))process.exitCode=1;
    }catch{process.stderr.write('The fixed live run could not proceed. '+usage);process.exitCode=1;}
}
