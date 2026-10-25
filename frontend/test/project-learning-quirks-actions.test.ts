// @vitest-environment jsdom
import {StrictMode,createElement} from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot,type Root} from 'react-dom/client';
import {createHash,webcrypto} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {learningDeferred} from './project-learning-hooks';
import {useLearningBridgeIntent} from '../src/features/ProjectLearning/useLearningBridgeIntent';
import {learningBridgeScope,type LearningBridgeInput} from '../src/features/ProjectLearning/learningBridgeIntent';
import {bridgeApi,type IBridgeJob} from '../src/features/McpBridge/api';

const fixture=vi.hoisted(()=>({scope:'',enabled:true,canManage:true}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>{const captureOwner=()=>{const scope=fixture.scope;return()=>scope===fixture.scope;};return {useAuthRequestOwner:()=>({scope:fixture.scope,captureOwner})};});
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{request:vi.fn(),cancel:vi.fn(async()=>{})}}));
const actor=(role='developer',name='Проект')=>JSON.stringify({id:'actor-1',email:'actor@example.test',activeRole:role,projectName:name});
const original:LearningBridgeInput={kind:'import-learning-quirks',projectId:'prj-quirks',deviceId:'device-fixture',assetId:'rag',assetKind:'mcp',version:12,
 requestKey:'11111111-1111-4111-8111-111111111111',expectedManifest:'a'.repeat(64),expectedBindingId:'b'.repeat(64),expectedInstanceId:'22222222-2222-4222-8222-222222222222',expectedConfigurationRevisions:[{assetId:'rag',manifest:'a'.repeat(64),revision:'config-1'}]};
const memory=(memoryMode:'sync'|'cleanup'):LearningBridgeInput=>({...original,kind:'sync-learning-memory',assetId:'memory',version:2,expectedConfigurationRevisions:undefined,expectedLearningRevision:4,expectedLearningDigest:'c'.repeat(64),memoryMode} as unknown as LearningBridgeInput);
const memoryInput=(mode:'sync'|'cleanup')=>{const input=memory(mode) as unknown as Record<string,unknown>;delete input.expectedConfigurationRevisions;return input as unknown as LearningBridgeInput;};
const fingerprint=(input:LearningBridgeInput,role='developer')=>createHash('sha256').update(JSON.stringify({role,request:Object.entries(input).sort(([a],[b])=>a.localeCompare(b))})).digest('hex');
const jobFor=(input:LearningBridgeInput,state='queued'):IBridgeJob=>({id:'job-fixture',projectId:input.projectId,deviceId:input.deviceId,kind:input.kind,state,message:'Принято',assetId:input.assetId,assetKind:input.assetKind,version:String(input.version),bindingId:input.expectedBindingId,expectedManifest:input.expectedManifest,expectedInstanceId:input.expectedInstanceId,createdAt:'now',updatedAt:'now'});
const receipt=(input:LearningBridgeInput,state='queued')=>({requestKey:input.requestKey,requestFingerprint:fingerprint(input),job:jobFor(input,state)});
const missing=()=>Object.assign(new Error('not found'),{response:{status:404}});
const create=vi.fn<(input:LearningBridgeInput)=>Promise<IBridgeJob>>(),reload=vi.fn(async()=>{});
let root:Root|undefined,container:HTMLDivElement,action:ReturnType<typeof useLearningBridgeIntent>,input:LearningBridgeInput;
function Harness(){action=useLearningBridgeIntent({projectId:input.projectId,kind:input.kind,canSend:value=>fixture.canManage&&(value.kind==='sync-learning-memory'&&value.memoryMode==='cleanup'||fixture.enabled),create,reload});return null;}
async function mount(){container=document.createElement('div');document.body.append(container);root=createRoot(container);await render();}
async function render(){
 await act(async()=>root!.render(createElement(StrictMode,null,createElement(Harness))));
 // Recovery validates the saved fingerprint through real WebCrypto before its read completes.
 await vi.waitFor(async()=>{await act(async()=>{});expect(action.loading).toBe(false);});
}
async function close(){await act(async()=>root?.unmount());root=undefined;container?.remove();}
async function send(value=input){await act(async()=>{await action.send(value);});}
async function check(){await act(async()=>{await action.check();});}
async function repeat(){await act(async()=>{await action.repeat();});}
beforeEach(()=>{vi.clearAllMocks();create.mockReset();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);sessionStorage.clear();input=structuredClone(original);fixture.scope=actor();fixture.enabled=true;fixture.canManage=true;create.mockImplementation(async value=>jobFor(value));vi.mocked(bridgeApi.request).mockRejectedValue(missing());});
afterEach(async()=>{await close();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('Durable learning bridge intent in React StrictMode',()=>{
 it.each(['quirks','sync','cleanup'] as const)('lost %s POST survives disposal and a fresh mount only reads its exact key',async mode=>{
  input=mode==='quirks'?structuredClone(original):memoryInput(mode);const pending=learningDeferred<IBridgeJob>(),started=learningDeferred<void>();create.mockImplementation(()=>{started.resolve();return pending.promise;});await mount();let flight!:Promise<void>;
  await act(async()=>{flight=action.send(input);await started.promise;});
  expect(create).toHaveBeenCalledOnce();const saved=JSON.parse(sessionStorage.getItem(learningBridgeScope(fixture.scope,input.projectId,input.kind))!);
  expect(saved).toEqual({actorRole:'developer',requestFingerprint:fingerprint(input),input});expect(JSON.stringify(saved)).not.toMatch(/memoryText|configValues|token|quirksText/);
  await close();vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input));await mount();
  expect(bridgeApi.request).toHaveBeenCalledWith(input.requestKey);expect(action.submitted?.id).toBe('job-fixture');expect(action.intent).toEqual(input);expect(create).toHaveBeenCalledOnce();
  pending.resolve(jobFor(input));await act(async()=>flight);expect(reload).not.toHaveBeenCalled();
 });
 it('404 keeps the original fence after target/config changes and only explicit resend uses the original body',async()=>{
  create.mockRejectedValueOnce(new Error('ACK lost'));await mount();await send();await check();expect(action.missing).toBe(true);
  const next={...input,deviceId:'different-device',expectedConfigurationRevisions:[{assetId:'rag',manifest:input.expectedManifest,revision:'config-2'}]} as LearningBridgeInput;
  await send(next);expect(create).toHaveBeenCalledOnce();vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input));await repeat();
  expect(create.mock.calls[1][0]).toEqual(input);expect(action.submitted?.id).toBe('job-fixture');
 });
 it('a definitive first 409 frees the form for an explicit corrected request',async()=>{
  create.mockRejectedValueOnce(Object.assign(new Error('configuration changed'),{response:{status:409}}));await mount();await send();expect(action.intent).toBeUndefined();expect(sessionStorage.length).toBe(0);
  const corrected={...input,requestKey:'33333333-3333-4333-8333-333333333333',expectedConfigurationRevisions:[]} as LearningBridgeInput;
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(corrected));await send(corrected);expect(create).toHaveBeenCalledTimes(2);expect(action.intent).toEqual(corrected);
 });
 it('a 409 during resend cannot erase a previously unknown original request',async()=>{
  create.mockRejectedValueOnce(new Error('ACK lost')).mockRejectedValueOnce(Object.assign(new Error('configuration changed'),{response:{status:409}}));await mount();await send();await check();await repeat();
  expect(action.intent).toEqual(input);expect(sessionStorage.length).toBe(1);await send({...input,deviceId:'other'});expect(create).toHaveBeenCalledTimes(2);
 });
 it('another instance changing the full envelope under the same key cannot make a retained resend post its body',async()=>{
  input=memoryInput('sync');create.mockRejectedValueOnce(new Error('ACK lost'));await mount();await send();await check();const repeatOriginal=action.repeat;
  const changed={...input,memoryMode:'cleanup',expectedLearningRevision:999} as LearningBridgeInput;
  sessionStorage.setItem(learningBridgeScope(fixture.scope,input.projectId,input.kind),JSON.stringify({actorRole:'developer',requestFingerprint:fingerprint(changed),input:changed}));
  await act(async()=>repeatOriginal());expect(create).toHaveBeenCalledOnce();expect(action.intent).toEqual(input);expect(action.blocked).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(learningBridgeScope(fixture.scope,input.projectId,input.kind))!).input).toEqual(changed);
 });
 it('a late acknowledgement cannot update the view or clear another full envelope under the same key',async()=>{
  const pending=learningDeferred<IBridgeJob>(),started=learningDeferred<void>();create.mockImplementationOnce(()=>{started.resolve();return pending.promise;});await mount();let flight!:Promise<void>;
  await act(async()=>{flight=action.send(input);await started.promise;});const changed={...input,expectedConfigurationRevisions:[]} as LearningBridgeInput;
  sessionStorage.setItem(learningBridgeScope(fixture.scope,input.projectId,input.kind),JSON.stringify({actorRole:'developer',requestFingerprint:fingerprint(changed),input:changed}));
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input,'succeeded'));pending.resolve(jobFor(input));await act(async()=>flight);
  expect(action.submitted).toBeUndefined();expect(action.blocked).toBe(true);expect(reload).not.toHaveBeenCalled();expect(JSON.parse(sessionStorage.getItem(learningBridgeScope(fixture.scope,input.projectId,input.kind))!).input).toEqual(changed);
 });
 it('flag OFF retains exact-key recovery and cancellation while blocking resend/new collection',async()=>{
  create.mockRejectedValueOnce(new Error('ACK lost'));await mount();await send();await close();fixture.enabled=false;await mount();await repeat();await send();expect(create).toHaveBeenCalledOnce();
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input));await check();expect(action.submitted?.state).toBe('queued');await act(async()=>action.cancel('job-fixture',true));expect(bridgeApi.cancel).toHaveBeenCalledWith('job-fixture');
 });
 it('flag OFF preserves the existing explicit Memory cleanup exception',async()=>{
  input=memoryInput('cleanup');fixture.enabled=false;vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input));await mount();await send();expect(create).toHaveBeenCalledOnce();
 });
 it.each(['requestKey','projectId','deviceId','kind','assetId','assetKind','version','expectedManifest','bindingId','expectedInstanceId','fingerprint','null fingerprint'])('rejects a mismatched %s receipt without erasing the original fence',async field=>{
  create.mockRejectedValueOnce(new Error('ACK lost'));await mount();await send();const found=receipt(input,'succeeded');
  if(field==='requestKey')found.requestKey='different-key';else if(field==='fingerprint')found.requestFingerprint='f'.repeat(64);else if(field==='null fingerprint')(found as {requestFingerprint:string|null}).requestFingerprint=null;else (found.job as unknown as Record<string,unknown>)[field]='different';
  vi.mocked(bridgeApi.request).mockResolvedValue(found);await check();expect(action.submitted).toBeUndefined();expect(action.intent).toEqual(input);expect(action.blocked).toBe(true);expect(sessionStorage.length).toBe(1);
 });
 it.each(['mode','revision','configuration'] as const)('rejects a receipt for a different full-intent %s fingerprint',async change=>{
  if(change!=='configuration')input=memoryInput('sync');create.mockRejectedValueOnce(new Error('ACK lost'));await mount();await send();
  const different=change==='mode'?{...input,memoryMode:'cleanup'}:change==='revision'?{...input,expectedLearningRevision:999}:{...input,expectedConfigurationRevisions:[]};
  vi.mocked(bridgeApi.request).mockResolvedValue({...receipt(input,'succeeded'),requestFingerprint:fingerprint(different as LearningBridgeInput)});await check();expect(action.blocked).toBe(true);expect(action.intent).toEqual(input);expect(sessionStorage.length).toBe(1);
 });
 it('role and project-name changes share the durable principal bucket but cannot replay under a different actor role',async()=>{
  create.mockRejectedValueOnce(new Error('ACK lost'));await mount();await send();const bucket=learningBridgeScope(fixture.scope,input.projectId,input.kind);
  fixture.scope=actor('admin','Новое имя');await render();expect(learningBridgeScope(fixture.scope,input.projectId,input.kind)).toBe(bucket);expect(action.intent).toEqual(input);expect(action.roleChanged).toBe(true);await repeat();await send();expect(create).toHaveBeenCalledOnce();
  fixture.scope=actor('developer','Новое имя');await render();expect(action.roleChanged).toBe(false);vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input));await repeat();expect(create.mock.calls[1][0]).toEqual(input);
 });
 it('an A → B → A late ACK cannot clear or replace a newer persisted intent',async()=>{
  const pending=learningDeferred<IBridgeJob>(),started=learningDeferred<void>();create.mockImplementationOnce(()=>{started.resolve();return pending.promise;});await mount();let flight!:Promise<void>;
  await act(async()=>{flight=action.send(input);await started.promise;});fixture.scope=actor('admin');await render();fixture.scope=actor();await render();
  const replacement={...input,requestKey:'33333333-3333-4333-8333-333333333333'};sessionStorage.setItem(learningBridgeScope(fixture.scope,input.projectId,input.kind),JSON.stringify({actorRole:'developer',requestFingerprint:fingerprint(replacement),input:replacement}));
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(replacement));await check();pending.resolve(jobFor(input));await act(async()=>flight);expect(action.intent).toEqual(replacement);expect(JSON.parse(sessionStorage.getItem(learningBridgeScope(fixture.scope,input.projectId,input.kind))!).input).toEqual(replacement);expect(reload).not.toHaveBeenCalled();
 });
 it.each(['read','write'] as const)('storage %s failure prevents a new POST',async operation=>{
  await mount();vi.spyOn(Storage.prototype,operation==='read'?'getItem':'setItem').mockImplementation(()=>{throw new Error('storage blocked');});await send();expect(create).not.toHaveBeenCalled();expect(action.blocked).toBe(true);
 });
 it('storage permission recovery and a read check reopen the current form without remounting',async()=>{
  await mount();const failure=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage blocked');});await send();expect(action.blocked).toBe(true);expect(create).not.toHaveBeenCalled();failure.mockRestore();await check();expect(action.blocked).toBe(false);
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input));await send();expect(create).toHaveBeenCalledOnce();
 });
 it('a terminal receipt with failed cleanup retains the original fence and cannot start a replacement',async()=>{
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input,'succeeded'));await mount();vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('storage blocked');});await send();expect(action.intent).toEqual(input);expect(action.submitted?.state).toBe('succeeded');await send({...input,deviceId:'other'});expect(create).toHaveBeenCalledOnce();expect(sessionStorage.length).toBe(1);
 });
 it('accepted pending work stays recoverable after close when the latest jobs page no longer contains it',async()=>{
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input));await mount();await send();await close();await mount();expect(action.submitted?.state).toBe('queued');expect(action.intent).toEqual(input);expect(create).toHaveBeenCalledOnce();
  vi.mocked(bridgeApi.request).mockResolvedValue(receipt(input,'succeeded'));await check();expect(action.intent).toBeUndefined();expect(sessionStorage.length).toBe(0);
 });
});
