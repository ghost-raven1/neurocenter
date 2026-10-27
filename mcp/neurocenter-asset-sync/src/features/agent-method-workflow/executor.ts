import {hub,readState,type Credentials} from '../../bridge/state.js';
import {projectFolder,projectBindingId,projectInstanceId} from '../../bridge/workspace.js';
import {withProjectFiles} from '../../bridge/installation-files.js';
import {roleMcpLifecycleSupported} from '../system-role-mcp/owned-process.js';
import {assertMethodQuirkStorage} from '../project-learning-quirks/method-preflight.js';
import {AGENT_METHOD_WORKFLOW_PROTOCOL,agentMethodWorkflowDigest,agentMethodWorkflowAgentIdentity,normalizeAgentMethodWorkflowPayload,normalizeAgentMethodWorkflowResult,
 type AgentMethodWorkflowPayload,type AgentMethodWorkflowResult,type AgentMethodFailureCode} from './contract.js';
import {MethodExecutionError,runMethodCommand,type MethodCommandRunner} from './process.js';
import {prepareMethod,methodEnvironment,type PreparedMethod} from './preparation.js';
import {snapshotWorkspace,methodChanges,type WorkspaceSnapshot} from './snapshot.js';
import {assertMethodCompleted} from './completion.js';
import {assertSelectedMethodAgent} from './selected-agent.js';
import {readMethodReceipt,writeMethodReceipt,methodProcessJournal,stopReceiptProcess,methodCompletionSummary,type MethodReceipt} from './receipts.js';

interface MethodJob {id:string;lease:string;project_id?:string;payload:unknown}
export interface MethodExecutorDependencies {
 /** Native fixtures inject a harmless executable; production always resolves real pinned method and coding CLIs. */
 prepare?:(root:string,payload:AgentMethodWorkflowPayload,run:MethodCommandRunner)=>Promise<PreparedMethod>;
 pollMs?:number;
}
const active=new Map<string,{controller:AbortController;finished:Promise<void>}>();
const setupCodes:AgentMethodFailureCode[]=['METHOD_MISSING','METHOD_VERSION','PROJECT_NOT_INITIALIZED','METHOD_WORKFLOW_MISSING','RUNTIME_MISSING','CHECKS_REQUIRED','UNSUPPORTED_PLATFORM','QUIRK_STORAGE_INVALID','SELECTED_AGENT_NOT_READY'];
function failedResult(result:AgentMethodWorkflowResult,code:AgentMethodFailureCode):AgentMethodWorkflowResult{
 return {...result,state:setupCodes.includes(code)?'needs_setup':code==='CANCELLED'?'cancelled':'failed',failure:{code,
  action:code==='SELECTED_AGENT_NOT_READY'?'setup-agent':code==='QUIRK_STORAGE_INVALID'||code==='WORKSPACE_CHANGED'?'inspect-workspace':code==='RUNTIME_MISSING'?'setup-runtime':setupCodes.includes(code)?'setup-method':'review-result'}};
}
function initialResult(payload:AgentMethodWorkflowPayload):AgentMethodWorkflowResult{
 return {protocol:AGENT_METHOD_WORKFLOW_PROTOCOL,workflowId:payload.workflowId,method:payload.method,methodVersion:payload.methodVersion,runtime:'opencode',
  state:'unknown',stage:'prerequisites',codeChanged:false,changes:[],artifacts:[],checks:payload.checks.map(check=>({...check,exitCode:null,signal:null,state:'not_run'})),...(payload.agent?{agent:agentMethodWorkflowAgentIdentity(payload.agent)}:{}),
  failure:{code:'UNKNOWN_OUTCOME',action:'inspect-workspace'}};
}
const durableError=(cause?:unknown)=>Object.assign(new Error('Результат разработки требует восстановления; новый запуск автоматически не выполняется.',{cause}),{localChangesCommitted:true});

/** Shutdown waits for the owned runtime/check descendants to close before the worker may exit. */
export async function stopMethodWorkflows():Promise<void>{
 const runs=[...active.values()];for(const run of runs)run.controller.abort(new MethodExecutionError('CANCELLED'));await Promise.all(runs.map(run=>run.finished));
}

/** One accepted intent executes at most once. Replay only returns its private receipt, including after a lost completion ACK. */
export async function runAgentMethodWorkflow(job:MethodJob,deviceId:string,authorize:()=>Promise<unknown>,progress:(percent:number,message:string)=>Promise<unknown>=async()=>{},dependencies:MethodExecutorDependencies={}){
 const payload=normalizeAgentMethodWorkflowPayload(job.payload),payloadHash=agentMethodWorkflowDigest(payload);
 if(payload.projectId!==job.project_id)throw new MethodExecutionError('WORKSPACE_CHANGED');
 let receipt=await readMethodReceipt(payload.workflowId);
 if(receipt&&(receipt.jobId!==job.id||receipt.deviceId!==deviceId||receipt.payloadHash!==payloadHash))throw durableError();
 if(receipt?.state==='completed')return methodCompletionSummary(receipt);
 if(active.has(payload.workflowId))throw durableError();
 if(receipt){await stopReceiptProcess(receipt);const completed:MethodReceipt={...receipt,state:'completed',result:{...receipt.result,state:'unknown',failure:{code:'UNKNOWN_OUTCOME',action:'inspect-workspace'}}};await writeMethodReceipt(completed,receipt);return methodCompletionSummary(completed);}
 const controller=new AbortController();let resolveFinished:()=>void=()=>{};
 const finished=new Promise<void>(resolve=>{resolveFinished=resolve;});active.set(payload.workflowId,{controller,finished});
 const site=hub(),deadline=Math.min(Date.parse(payload.deadlineAt),Date.now()+15*60*1000);let env:NodeJS.ProcessEnv;
 const timer=setTimeout(()=>controller.abort(new MethodExecutionError('TIMEOUT')),Math.max(0,deadline-Date.now()));
 let poll:ReturnType<typeof setInterval>|undefined,pollPending=false,root:string|undefined,before:WorkspaceSnapshot|undefined,result=initialResult(payload),runningCheck:number|undefined;
 let quirk:Awaited<ReturnType<typeof assertMethodQuirkStorage>>|undefined;
 const save=async(next:MethodReceipt)=>{await writeMethodReceipt(next,receipt);receipt=next;};
 const identity=async()=>{
   const credentials=await readState<Credentials>('credentials');
   if(hub()!==site||credentials?.deviceId!==deviceId)throw new MethodExecutionError('AUTHORIZATION_LOST');
   if(root&&(await projectFolder(payload.projectId)!==root||await projectBindingId(payload.projectId)!==payload.bindingId||await projectInstanceId(payload.projectId)!==payload.instanceId))throw new MethodExecutionError('WORKSPACE_CHANGED');
 };
 const current=async()=>{
  controller.signal.throwIfAborted();
  await identity();
  try{await authorize();}catch{throw new MethodExecutionError('AUTHORIZATION_LOST');}
  controller.signal.throwIfAborted();await identity();
 };
 const admit=async()=>{await current();try{await quirk?.assertCurrent();}catch(error){if((error as {code?:unknown})?.code==='QUIRK_STORAGE_INVALID')throw new MethodExecutionError('QUIRK_STORAGE_INVALID');throw error;}if(root)await assertSelectedMethodAgent(root,payload,current);};
 const observeFailure=async()=>{
  if(!before||!root||!receipt)return;
  await stopReceiptProcess(receipt);
  const observation=new AbortController(),timeout=setTimeout(()=>observation.abort(new MethodExecutionError('TIMEOUT')),5000);
  // Reading an outcome does not grant another model/command task, and revoked or changed scope is never inspected.
  const inspect=async()=>{await identity();try{await authorize();}catch{throw new MethodExecutionError('AUTHORIZATION_LOST');}await identity();observation.signal.throwIfAborted();};
  try{
   await inspect();await save({...receipt,result});
   const run:MethodCommandRunner=async(command,args,capture=false)=>{
    if(command!=='git')throw new MethodExecutionError('EXECUTION_FAILED');await inspect();const journal=await methodProcessJournal(receipt!,save);
    return runMethodCommand(command,args,root!,env,inspect,observation.signal,journal,capture);
   };
   result={...result,...methodChanges(before,await snapshotWorkspace(root,run),payload.method)};
  }finally{clearTimeout(timeout);}
 };
 try{
  env=methodEnvironment();
  if(!roleMcpLifecycleSupported())throw new MethodExecutionError('UNSUPPORTED_PLATFORM');
  root=await projectFolder(payload.projectId);
  if(await projectBindingId(payload.projectId)!==payload.bindingId||await projectInstanceId(payload.projectId)!==payload.instanceId)throw new MethodExecutionError('WORKSPACE_CHANGED');
  await current();
  try{quirk=await assertMethodQuirkStorage(root,current);}catch(error){if((error as {code?:unknown})?.code==='QUIRK_STORAGE_INVALID')throw new MethodExecutionError('QUIRK_STORAGE_INVALID');throw error;}
  await assertSelectedMethodAgent(root,payload,current);
  await save({schemaVersion:1,jobId:job.id,lease:job.lease,deviceId,workflowId:payload.workflowId,payloadHash,state:'started',result});
  poll=setInterval(()=>{if(pollPending)return;pollPending=true;void admit().catch(error=>controller.abort(error)).finally(()=>{pollPending=false;});},dependencies.pollMs??1000);
  const run:MethodCommandRunner=async(command,args,capture=false)=>{
   await admit();const journal=await methodProcessJournal(receipt!,save);
   return runMethodCommand(command,args,root!,env,admit,controller.signal,journal,capture);
  };
  await progress(5,'Проверяем установленные методику, исполнитель и привязку проекта.');
  const prepared=await (dependencies.prepare??prepareMethod)(root,payload,run);
  // The same project file lock used by managed installs protects the complete accepted execution.
  await withProjectFiles(payload.projectId,async lockedRoot=>{
   if(lockedRoot!==root)throw new MethodExecutionError('WORKSPACE_CHANGED');await current();before=await snapshotWorkspace(root!,run);
   result={...result,stage:'execution'};await save({...receipt!,result});
   await progress(15,'Выполняем полный цикл методики и работу с кодом в локальной папке.');
   const coding=await run(prepared.command,prepared.args,!!prepared.outputProtocol);
   result={...result,...methodChanges(before!,await snapshotWorkspace(root!,run),payload.method)};
   if(prepared.outputProtocol){
    const events=coding.stdout.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line) as {type?:string;protocol?:string;code?:string};}catch{return {type:'invalid'};}});
    const failure=events.find(event=>event.type==='agent_method_failed'&&event.protocol===prepared.outputProtocol);
    if(failure)throw new MethodExecutionError(failure.code==='OUTPUT_LIMIT'||failure.code==='TIMEOUT'||failure.code==='SELECTED_AGENT_NOT_READY'?failure.code:'EXECUTION_FAILED');
    if(events.length!==1||events[0]?.type!=='agent_method_completed'||events[0]?.protocol!==prepared.outputProtocol)throw new MethodExecutionError('EXECUTION_FAILED');
    if(!result.artifacts.length)throw new MethodExecutionError('EXECUTION_FAILED');
   }
   if(coding.code!==0||coding.signal)throw new MethodExecutionError('EXECUTION_FAILED');
   if(prepared.validate){const validation=await run(prepared.validate.command,prepared.validate.args);if(validation.code!==0||validation.signal)throw new MethodExecutionError('EXECUTION_FAILED');}
   result={...result,stage:'checks',...methodChanges(before!,await snapshotWorkspace(root!,run),payload.method)};await save({...receipt!,result});
   await progress(70,'Проверяем фактические изменения и запускаем выбранные команды проверки.');
   for(let index=0;index<payload.checks.length;index++){
    runningCheck=index;const check=payload.checks[index]!,checked=await run(check.command,check.args);
    result={...result,checks:result.checks.map((entry,current)=>current===index?{...check,exitCode:checked.code,signal:checked.signal,state:checked.code===0&&!checked.signal?'passed':'failed'}:entry)};runningCheck=undefined;
    await save({...receipt!,result});if(checked.code!==0||checked.signal)throw new MethodExecutionError('CHECK_FAILED');
   }
   result={...result,...methodChanges(before!,await snapshotWorkspace(root!,run),payload.method)};
   if(prepared.outputProtocol)await assertMethodCompleted(root!,payload,result,run);
   await admit();const {failure:_failure,...observed}=result;result={...observed,state:'succeeded',stage:'completed'};
  });
 }catch(error){
  const cause=controller.signal.aborted?controller.signal.reason:error;
  const code=cause instanceof MethodExecutionError?cause.code:'EXECUTION_FAILED';
  if(runningCheck!==undefined)result={...result,checks:result.checks.map((entry,index)=>index===runningCheck?{...entry,state:'failed'}:entry)};
  result=failedResult(result,code);
  try{await observeFailure();}catch{/* Keep earlier measured facts; unavailable outcome observation is never an empty-success claim. */}
 }finally{
  clearTimeout(timer);if(poll)clearInterval(poll);
  try{
   if(receipt)await stopReceiptProcess(receipt);
   if(result.state==='succeeded'&&payload.agent)try{await admit();}catch(error){const cause=controller.signal.aborted?controller.signal.reason:error;result=failedResult(result,cause instanceof MethodExecutionError?cause.code:'EXECUTION_FAILED');}
   result=normalizeAgentMethodWorkflowResult(result,payload);
   const completed:MethodReceipt={schemaVersion:1,jobId:job.id,lease:job.lease,deviceId,workflowId:payload.workflowId,payloadHash,state:'completed',result};
   await save(completed);
  }catch(cause){active.delete(payload.workflowId);resolveFinished();throw durableError(cause);}
  active.delete(payload.workflowId);resolveFinished();
 }
 return methodCompletionSummary(receipt!);
}
