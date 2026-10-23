import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import {learningDeferred,learningHooks,flushLearning} from './project-learning-hooks';
import {LearningMemorySyncModal} from '../src/features/ProjectLearning/LearningMemorySyncModal';
import {learningMemorySyncApi} from '../src/features/ProjectLearning/learningMemorySyncApi';
import {bridgeApi,type IBridgeJob} from '../src/features/McpBridge/api';

const fixture=vi.hoisted(()=>({hooks:undefined as ReturnType<typeof learningHooks>|undefined,bridge:{} as Record<string,any>,scope:'admin',enabled:true}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:(...args:Parameters<ReturnType<typeof learningHooks>['useState']>)=>fixture.hooks!.useState(...args),
 useRef:(...args:Parameters<ReturnType<typeof learningHooks>['useRef']>)=>fixture.hooks!.useRef(...args),useEffect:(...args:Parameters<ReturnType<typeof learningHooks>['useEffect']>)=>fixture.hooks!.useEffect(...args)}));
vi.mock('antd',()=>({Alert:'alert-fixture',Button:'button-fixture',Modal:'modal-fixture',Select:'select-fixture',Space:'space-fixture',Typography:{Paragraph:'p',Text:'span'}}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>fixture.bridge}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:fixture.enabled,reason:'Функция выключена'})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>{const captureOwner=()=>{const scope=fixture.scope;return()=>scope===fixture.scope;};return {useAuthRequestOwner:()=>({scope:fixture.scope,captureOwner})};});
vi.mock('../src/features/ProjectLearning/learningMemorySyncApi',()=>({learningMemorySyncApi:{create:vi.fn(),context:vi.fn()}}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{cancel:vi.fn(async()=>({ok:true}))}}));
vi.mock('../src/features/McpBridge/bridgeRequestKey',()=>({createBridgeRequestKey:()=> '11111111-1111-4111-8111-111111111111'}));

const projectId='project-memory',bindingId='a'.repeat(64),instanceId='22222222-2222-4222-8222-222222222222',manifest='b'.repeat(64);
const device={id:'device-fixture',name:'Рабочий Mac',online:true,report:{capabilities:['project-learning-memory-v1'],bindings:[{projectId,bindingId,instanceId}]}};
const installed={deviceId:device.id,projectId,assetId:'memory',assetKind:'mcp',version:2,name:'MCP Memory',manifest,bindingId,isCurrentBinding:true,learningMemory:{supported:true}};
const context={projectId,revision:2,digest:'c'.repeat(64),entries:[]};
const job={id:'job-fixture',kind:'sync-learning-memory',projectId,deviceId:device.id,state:'queued',message:'В очереди'} as IBridgeJob;
let props:{projectId:string;canManage:boolean;onClose:()=>void};
type Element=ReactElement<Record<string,any>>;
function elements(node:ReactNode):Element[]{
 if(Array.isArray(node))return node.flatMap(elements);if(!isValidElement(node))return [];
 const value=node as Element;return [value,...elements(value.props.children),...elements(value.props.action),...elements(value.props.footer)];
}
const render=()=>{fixture.hooks!.begin();const tree=LearningMemorySyncModal(props);fixture.hooks!.commit();return elements(tree);};
const button=(tree:Element[],text:string)=>tree.find(item=>item.type==='button-fixture'&&item.props.children===text)!;
async function ready(){render();await flushLearning();let tree=render();tree.find(item=>item.type==='select-fixture')!.props.onChange(JSON.stringify([device.id,installed.assetId,manifest]));return render();}
beforeEach(()=>{
 vi.clearAllMocks();fixture.hooks=learningHooks();fixture.scope='admin';fixture.enabled=true;props={projectId,canManage:true,onClose:vi.fn()};
 fixture.bridge={devices:[structuredClone(device)],installations:[structuredClone(installed)],jobs:[],devicesReady:true,reload:vi.fn(async()=>{})};
 vi.mocked(learningMemorySyncApi.context).mockResolvedValue(context as any);vi.mocked(learningMemorySyncApi.create).mockResolvedValue(job);
});
afterEach(()=>fixture.hooks?.dispose());
describe('Explicit approved project learning to Memory',()=>{
 it('selects exact installed device/pin and sends approved context revision with no learned text',async()=>{
  const tree=await ready();expect(button(tree,'Синхронизировать принятые знания').props.disabled).toBe(false);
  button(tree,'Синхронизировать принятые знания').props.onClick();await flushLearning();
  expect(learningMemorySyncApi.create).toHaveBeenCalledWith({kind:'sync-learning-memory',projectId,deviceId:device.id,requestKey:'11111111-1111-4111-8111-111111111111',assetId:'memory',assetKind:'mcp',version:2,expectedManifest:manifest,expectedBindingId:bindingId,expectedInstanceId:instanceId,expectedLearningRevision:2,expectedLearningDigest:context.digest,memoryMode:'sync'});
 });
 it('lost enqueue ACK keeps the exact request and allows its lookup replay after flag OFF',async()=>{
  vi.mocked(learningMemorySyncApi.create).mockRejectedValueOnce(new Error('ACK lost')).mockResolvedValueOnce(job);
  button(await ready(),'Синхронизировать принятые знания').props.onClick();await flushLearning();fixture.enabled=false;
  const tree=render();expect(button(tree,'Синхронизировать принятые знания').props.disabled).toBe(true);button(tree,'Проверить отправку').props.onClick();await flushLearning();
  expect(vi.mocked(learningMemorySyncApi.create).mock.calls[1]).toEqual(vi.mocked(learningMemorySyncApi.create).mock.calls[0]);
 });
 it.each(['offline','capability','binding','pin','role','flag'])('retained click refuses a revoked %s condition',async change=>{
  const action=button(await ready(),'Синхронизировать принятые знания').props.onClick;
  if(change==='offline')fixture.bridge.devices[0].online=false;
  if(change==='capability')fixture.bridge.devices[0].report.capabilities=[];
  if(change==='binding')fixture.bridge.installations[0].isCurrentBinding=false;
  if(change==='pin')fixture.bridge.installations[0].manifest='d'.repeat(64);
  if(change==='role')props.canManage=false;
  if(change==='flag')fixture.enabled=false;
  render();action();await flushLearning();expect(learningMemorySyncApi.create).not.toHaveBeenCalled();
 });
 it.each(['project','account'])('late job ACK cannot populate or reload another %s context',async change=>{
  const pending=learningDeferred<IBridgeJob>();vi.mocked(learningMemorySyncApi.create).mockReturnValue(pending.promise);
  button(await ready(),'Синхронизировать принятые знания').props.onClick();await flushLearning();
  if(change==='project')props.projectId='another-project';else fixture.scope='another-account';render();pending.resolve(job);await flushLearning();
  expect(fixture.bridge.reload).not.toHaveBeenCalled();expect(render().some(item=>item.props.message==='В очереди')).toBe(false);
 });
 it('flag OFF retains persisted history, running cancellation and cleanup while blocking new projection',async()=>{
  fixture.enabled=false;let tree=await ready();expect(button(tree,'Синхронизировать принятые знания').props.disabled).toBe(true);expect(button(tree,'Очистить отозванные записи').props.disabled).toBe(false);
  button(tree,'Очистить отозванные записи').props.onClick();await flushLearning();expect(vi.mocked(learningMemorySyncApi.create).mock.calls[0][0].memoryMode).toBe('cleanup');
  fixture.bridge.jobs=[{...job,state:'running',message:'Синхронизация выполняется'}];tree=render();button(tree,'Отменить').props.onClick();await flushLearning();expect(bridgeApi.cancel).toHaveBeenCalledWith(job.id);
 });
 it('old installed package provides an actionable update blocker',async()=>{
  fixture.bridge.installations[0].learningMemory=undefined;const tree=await ready();expect(button(tree,'Синхронизировать принятые знания').props.disabled).toBe(true);
  expect(tree.some(item=>item.props.message==='Обновите MCP Memory из каталога: эта версия не поддерживает синхронизацию.')).toBe(true);
 });
 it('retained submit cannot create another job after ACK while the jobs list is still refreshing',async()=>{
  const action=button(await ready(),'Синхронизировать принятые знания').props.onClick;action();await flushLearning();render();action();await flushLearning();expect(learningMemorySyncApi.create).toHaveBeenCalledOnce();
 });
 it('retained cancellation cannot mutate after the project role is revoked',async()=>{
  fixture.bridge.jobs=[{...job,state:'running'}];const action=button(await ready(),'Отменить').props.onClick;props.canManage=false;render();action();await flushLearning();expect(bridgeApi.cancel).not.toHaveBeenCalled();
 });
 it('a technical size refusal preserves target selection and offers an available next action',async()=>{
  fixture.bridge.jobs=[{...job,state:'failed',result:{status:'partial',code:'quota'}}];const tree=await ready();
  expect(tree.find(item=>typeof item.props.description==='string'&&item.props.description.includes('допустимый объём'))?.props.description).toBe('План превышает допустимый объём. Уменьшите объём и повторите; исходный выбор сохранён.');
  expect(tree.find(item=>item.type==='select-fixture')?.props.value).toBe(JSON.stringify([device.id,installed.assetId,manifest]));expect(button(tree,'Синхронизировать принятые знания').props.disabled).toBe(false);
 });
});
