import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {flushModal,modalAntd,uiNode} from './modal-actions.fixture';
const h=await vi.hoisted(async()=>{const f=await import('./modal-actions.fixture');const op={busy:false,job:undefined as any,error:'',submit:vi.fn(),setError:vi.fn()};return {hooks:f.modalHooks(),ui:f.modalUi(),op,close:vi.fn()};});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:h.hooks.state,useRef:h.hooks.ref,useEffect:h.hooks.effect}));
vi.mock('antd',async()=>modalAntd(h.ui,(await import('react')).createElement));
vi.mock('../src/features/McpBridge/useLocalJob',()=>({useLocalJob:()=>h.op}));
vi.mock('../src/features/McpBridge/LocalChangePreview',()=>({LocalChangePreview:({plan}:any)=>createElement('pre',null,plan.files.map((x:any)=>x.path).join('\n'))}));
import {LocalVariantsModal} from '../src/features/McpBridge/LocalVariantsModal';
const sha='a'.repeat(64),instanceId='22222222-2222-4222-8222-222222222222',recoveryId='33333333-3333-4333-8333-333333333333';
const first='.opencode/skills/tool/SKILL.md',second='.opencode/skills/tool/references/info.md';
const item={deviceId:'device',projectId:'project',assetId:'skill/tool',assetKind:'skill',name:'Skill',version:2,manifest:sha,bindingId:sha,folderName:'Project folder',updatedAt:'2026-10-22T10:00:00.000Z'} as any;
const binding=()=>({projectId:item.projectId,bindingId:sha,instanceId,valid:true,identityStatus:'verified'});
const variant=(eligible=true)=>({recoveryId,createdAt:'2026-10-22T09:00:00.000Z',files:eligible?2:0,eligible,reason:eligible?'ready':'invalid-backup'});
const variants=(entries=[variant()])=>({schemaVersion:1,projectId:item.projectId,bindingId:sha,instanceId,assetId:item.assetId,assetKind:item.assetKind,version:2,manifest:sha,checkedAt:new Date().toISOString(),complete:true,entries});
const plan=(paths=[first,second])=>({schemaVersion:1,planId:'11111111-1111-4111-8111-111111111111',revision:1,digest:sha,projectId:item.projectId,bindingId:sha,instanceId,assetId:item.assetId,assetKind:item.assetKind,version:2,manifest:sha,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15*60000).toISOString(),status:'prepared',files:paths.map(path=>({path,operation:'replace',beforeSha256:sha,afterSha256:'b'.repeat(64),beforeBytes:10,afterBytes:20,binary:false}))});
let bridge:any,canManage:boolean,canView:boolean,sequence:number;
function render(){h.hooks.begin();h.ui.nodes=[];const html=renderToStaticMarkup(createElement(LocalVariantsModal,{item,bridge,canManage,canView,onClose:h.close}));h.hooks.commit();return html;}
function complete(kind:string,result:any){h.op.job={id:'job-'+(++sequence),kind,state:'succeeded',result,message:'Completed',deviceId:item.deviceId,projectId:item.projectId,bindingId:sha,assetId:item.assetId,assetKind:item.assetKind,updatedAt:new Date().toISOString()};render();return render();}
async function listed(value=variants()){render();expect(h.op.submit).toHaveBeenCalledWith(expect.objectContaining({kind:'list-local-variants',expectedManifest:sha,expectedBindingId:sha}));complete('list-local-variants',value);await flushModal();return render();}
async function prepared(){await listed();uiNode(h.ui,'Button','Просмотреть восстановление').onClick();await flushModal();complete('prepare-local-restore',plan());return render();}
beforeEach(()=>{h.hooks.dispose();vi.useFakeTimers();vi.setSystemTime('2026-10-22T10:00:00.000Z');vi.clearAllMocks();h.op.busy=false;h.op.job=undefined;h.op.error='';h.op.submit.mockResolvedValue(undefined);h.op.setError.mockImplementation(message=>{h.op.error=message;});sequence=0;canManage=true;canView=true;
 bridge={device:{id:'device',role:'Разработчик',online:true,report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','local-recovery-v1'],bindings:[binding()]}},installations:[structuredClone(item)],jobs:[],devicesReady:true,jobsReady:true,installationsReady:true};});
afterEach(()=>{h.hooks.dispose();vi.useRealTimers();});
describe('Local variant restore actual guarded flow',()=>{
 it('loads once, prepares an exact immutable tuple and requires explicit confirmation before apply',async()=>{
  await prepared();expect(h.op.submit).toHaveBeenCalledTimes(2);const apply=uiNode(h.ui,'Button','Сохранить нынешний вариант');expect(apply.disabled).toBe(true);apply.onClick();await flushModal();expect(h.op.submit).toHaveBeenCalledTimes(2);
  uiNode(h.ui,'Checkbox','Подтверждаю').onChange({target:{checked:true}});render();expect(uiNode(h.ui,'Button','Сохранить нынешний вариант').disabled).toBe(false);uiNode(h.ui,'Button','Открыть полный diff').onClick();uiNode(h.ui,'Button','Сохранить нынешний вариант').onClick();await flushModal();expect(h.op.submit).toHaveBeenLastCalledWith(expect.objectContaining({kind:'apply-local-restore',changePlanId:plan().planId,changePlanRevision:1,expectedChangeDigest:sha,expectedManifest:sha}));
  expect(complete('apply-local-restore',{})).toContain('Выбранный локальный вариант восстановлен');
 });
 it('changing selected paths invalidates consent and requires a fresh matching subset preview',async()=>{
  await prepared();uiNode(h.ui,'Checkbox','Подтверждаю').onChange({target:{checked:true}});render();uiNode(h.ui,'Checkbox',first).onChange({target:{checked:false}});expect(render()).toContain('Выбор изменился');expect(uiNode(h.ui,'Button','Сохранить нынешний вариант').disabled).toBe(true);uiNode(h.ui,'Button','Подготовить выбранные').onClick();await flushModal();expect(h.op.submit).toHaveBeenLastCalledWith(expect.objectContaining({kind:'prepare-local-restore',recoveryId,restorePaths:[second]}));
  complete('prepare-local-restore',{...plan([second]),digest:'c'.repeat(64)});expect(uiNode(h.ui,'Checkbox','Подтверждаю').checked).toBe(false);expect(h.ui.nodes.filter(n=>n.kind==='Checkbox').some(n=>n.text===first)).toBe(true);uiNode(h.ui,'Checkbox',first).onChange({target:{checked:true}});render();expect(uiNode(h.ui,'Button','Сохранить нынешний вариант').disabled).toBe(true);
 });
 it('server subset mismatch discards the untrusted preview and lets the user start over',async()=>{
  await prepared();uiNode(h.ui,'Checkbox',first).onChange({target:{checked:false}});render();uiNode(h.ui,'Button','Подготовить выбранные').onClick();await flushModal();complete('prepare-local-restore',plan([first]));expect(h.op.setError).toHaveBeenCalledWith(expect.stringContaining('Состав файлов изменился'));expect(render()).not.toContain('Подтверждаю весь');
 });
 it('zero selection cannot prepare/apply and choosing another variant clears plan and consent',async()=>{
  await prepared();uiNode(h.ui,'Checkbox',first).onChange({target:{checked:false}});render();uiNode(h.ui,'Checkbox',second).onChange({target:{checked:false}});expect(render()).toContain('Выберите хотя бы один файл');expect(uiNode(h.ui,'Button','Подготовить выбранные').disabled).toBe(true);const before=h.op.submit.mock.calls.length;uiNode(h.ui,'Button','Подготовить выбранные').onClick();await flushModal();expect(h.op.setError).toHaveBeenCalledWith(expect.stringContaining('Выберите хотя бы один файл'));expect(h.op.submit).toHaveBeenCalledTimes(before);uiNode(h.ui,'Button','Выбрать другой вариант').onClick();expect(render()).toContain('Просмотреть восстановление');
 });
 it('observer may list but cannot prepare a restore or open writable recovery actions',async()=>{
  canManage=false;expect(await listed()).toContain('Список доступен для просмотра');expect(uiNode(h.ui,'Button','Просмотреть восстановление').disabled).toBe(true);uiNode(h.ui,'Button','Просмотреть восстановление').onClick();await flushModal();expect(h.op.submit).toHaveBeenCalledTimes(1);expect(h.op.setError).toHaveBeenCalledWith(expect.stringContaining('роли разработчика'));
 });
 it.each(['offline','permission','binding','pending'])('%s changes invalidate a prepared restore even through a captured click handler',async issue=>{
  await prepared();uiNode(h.ui,'Checkbox','Подтверждаю').onChange({target:{checked:true}});render();const click=uiNode(h.ui,'Button','Сохранить нынешний вариант').onClick;
  if(issue==='offline')bridge.device.online=false;if(issue==='permission')canManage=false;if(issue==='binding')bridge.device.report.bindings[0]={...binding(),bindingId:'b'.repeat(64)};if(issue==='pending')bridge.jobs=[{id:'foreign',deviceId:item.deviceId,projectId:item.projectId,bindingId:sha,assetId:item.assetId,assetKind:item.assetKind,kind:'uninstall',state:'running'}];render();const before=h.op.submit.mock.calls.length;click();await flushModal();expect(h.op.submit).toHaveBeenCalledTimes(before);expect(h.op.setError).toHaveBeenCalled();
 });
 it('expired list/plan cannot prepare or apply; a new listing recovers without stale consent',async()=>{
  await prepared();uiNode(h.ui,'Checkbox','Подтверждаю').onChange({target:{checked:true}});render();vi.advanceTimersByTime(16*60000);expect(render()).toContain('Подготовка устарела');const before=h.op.submit.mock.calls.length;uiNode(h.ui,'Button','Сохранить нынешний вариант').onClick();await flushModal();expect(h.op.submit).toHaveBeenCalledTimes(before);uiNode(h.ui,'Button','Выбрать другой вариант').onClick();render();expect(uiNode(h.ui,'Button','Просмотреть восстановление').disabled).toBe(true);uiNode(h.ui,'Button','Обновить список').onClick();await flushModal();complete('list-local-variants',variants());expect(uiNode(h.ui,'Button','Просмотреть восстановление').disabled).toBe(false);
 });
 it('mismatched list and wrong-instance preview never become restorable',async()=>{
  render();complete('list-local-variants',{...variants(),instanceId:'44444444-4444-4444-8444-444444444444'});expect(h.op.setError).toHaveBeenCalledWith(expect.stringContaining('Список не соответствует'));complete('list-local-variants',variants());uiNode(h.ui,'Button','Просмотреть восстановление').onClick();await flushModal();complete('prepare-local-restore',{...plan(),instanceId:'44444444-4444-4444-8444-444444444444'});expect(h.op.setError).toHaveBeenCalledWith(expect.stringContaining('Подготовка восстановления не соответствует'));expect(render()).not.toContain('Подтверждаю весь');
 });
 it('empty/incomplete/unverified lists are truthful, job failures visible and close is locked while submitting',async()=>{
  expect(await listed({...variants([]),complete:false})).toContain('Список неполный');expect(render()).toContain('нет сохранённых локальных вариантов');complete('list-local-variants',variants([variant(false)]));const before=h.op.submit.mock.calls.length;uiNode(h.ui,'Button','Просмотреть восстановление').onClick();await flushModal();expect(h.op.submit).toHaveBeenCalledTimes(before);
  h.op.job={id:'failed',state:'failed',message:'Cannot read backup'};h.op.error='Retry listing';expect(render()).toContain('Cannot read backup');expect(render()).toContain('Retry listing');h.op.busy=true;render();uiNode(h.ui,'Modal').onCancel();expect(h.close).not.toHaveBeenCalled();h.op.busy=false;render();uiNode(h.ui,'Modal').onCancel();expect(h.close).toHaveBeenCalledOnce();
 });
 it('opens the recovery folder using only the current project binding and refresh resets pending preview',async()=>{
  await listed();uiNode(h.ui,'Button','Открыть резервные копии').onClick();await flushModal();expect(h.op.submit).toHaveBeenLastCalledWith({kind:'open-local-recovery-folder',deviceId:item.deviceId,projectId:item.projectId,expectedBindingId:sha});uiNode(h.ui,'Button','Просмотреть восстановление').onClick();await flushModal();uiNode(h.ui,'Button','Обновить список').onClick();await flushModal();complete('prepare-local-restore',plan());expect(render()).not.toContain('Подтверждаю весь');
 });
 it('no view access never initiates automatic reads; running own jobs block refresh',async()=>{
  canView=false;render();expect(h.op.submit).not.toHaveBeenCalled();canView=true;h.op.job={id:'running',state:'running',kind:'list-local-variants'};render();uiNode(h.ui,'Button','Обновить список').onClick();await flushModal();expect(h.op.submit).not.toHaveBeenCalled();
 });
 it('a completed external mutation invalidates the old preview; accepted restore remains a truthful success',async()=>{
  await prepared();bridge.jobs=[{id:'external',kind:'install',state:'succeeded',updatedAt:new Date().toISOString(),deviceId:item.deviceId,projectId:item.projectId,bindingId:sha,assetId:item.assetId,assetKind:item.assetKind}];render();render();expect(render()).not.toContain('Подтверждаю весь');const count=h.op.submit.mock.calls.length;uiNode(h.ui,'Button','Обновить список').onClick();await flushModal();complete('list-local-variants',variants());uiNode(h.ui,'Button','Просмотреть восстановление').onClick();await flushModal();complete('prepare-local-restore',plan());h.op.busy=true;render();uiNode(h.ui,'Button','Подготовить выбранные').onClick();await flushModal();expect(h.op.submit.mock.calls.length).toBe(count+2);h.op.busy=false;
  h.op.job={...h.op.job,id:'accepted',kind:'apply-local-restore',state:'succeeded'};bridge.jobs=[h.op.job];render();expect(render()).toContain('Выбранный локальный вариант восстановлен');
 });
});
