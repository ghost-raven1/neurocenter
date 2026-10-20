import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {StoredBuildDraft} from '../src/modules/Store/packaging/buildDraftStore';
import type {NpmPackageMetadata,ToolBuild} from '../src/modules/Store/packaging/types';
import type {SourceUpload,SourceUploadIntent} from '../src/modules/Store/packaging/uploadTypes';
import type {useSourceUpload} from '../src/modules/Store/packaging/useSourceUpload';

// Commit effects between deferred completions to exercise actual Modal ownership boundaries.
const hooks=vi.hoisted(()=>{
 let cursor=0;
 const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
 const same=(a?:unknown[],b?:unknown[])=>!!a&&!!b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
  useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return [slot.value,(next:T|((previous:T)=>T))=>{slot.value=typeof next==='function'?(next as (previous:T)=>T)(slot.value as T):next;}];},
  useRef<T>(initial?:T){return(slots[cursor++]??={value:{current:initial}}).value;},
  useMemo(factory:()=>unknown,deps:unknown[]){const at=cursor++,old=slots[at];if(!old||!same(old.deps,deps))slots[at]={value:factory(),deps};return slots[at].value;},
  useEffect(effect:()=>void|(()=>void),deps:unknown[]){const at=cursor++,old=slots[at];if(old&&same(old.deps,deps))return;const slot=slots[at]={deps};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});},
 };
});
interface InputProps {value?:string;'aria-label'?:string;onChange?:(event:{target:{value:string}})=>void}
interface ButtonProps {children?:ReactNode;disabled?:boolean;onClick?:()=>void}
interface SelectProps {'aria-label'?:string;value?:string;disabled?:boolean;onChange:(value:string)=>void}
const ui=vi.hoisted(()=>({
 scope:'actor-a:main-admin',projectId:'project-a',open:true,epoch:0,
 owners:new Map<number,()=>()=>boolean>(),inputs:new Map<string,InputProps>(),buttons:new Map<string,ButtonProps>(),selects:new Map<string,SelectProps>(),
 source:'',selectSource:undefined as ((event:{target:{value:string}})=>void)|undefined,
 formDisabled:false,finish:undefined as (()=>void)|undefined,close:undefined as (()=>void)|undefined,
 job:undefined as ToolBuild|undefined,draft:undefined as StoredBuildDraft|undefined,unresolved:false,recoveryBlocked:false,
 npmMetadata:undefined as NpmPackageMetadata|undefined,
 upload:undefined as SourceUpload|undefined,intent:undefined as SourceUploadIntent|undefined,uploadBusy:false,phase:'idle' as ReturnType<typeof useSourceUpload>['phase'],
 submit:vi.fn(),retrySaved:vi.fn(),reset:vi.fn(),forget:vi.fn(),restore:vi.fn(),select:vi.fn(),cancel:vi.fn(),recheck:vi.fn(),resolve:vi.fn(),
}));
const uploadIO=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),clear:vi.fn(),create:vi.fn(),content:vi.fn(),lookup:vi.fn(),get:vi.fn(),cancel:vi.fn(),stored:new Map<string,SourceUploadIntent>()}));
vi.mock('../src/modules/Store/packaging/sourceUploadApi',()=>({sourceUploadApi:uploadIO}));
vi.mock('../src/modules/Store/packaging/uploadDraftStore',()=>({readUploadIntent:uploadIO.read,saveUploadIntent:uploadIO.save,clearUploadIntent:uploadIO.clear}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useMemo:hooks.useMemo,useEffect:hooks.useEffect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
 if(!ui.owners.has(ui.epoch)){const epoch=ui.epoch;ui.owners.set(epoch,()=>()=>ui.epoch===epoch);}
 return {captureOwner:ui.owners.get(ui.epoch)!};
}}));
vi.mock('../src/modules/Store/packaging/useToolBuild',()=>({useToolBuild:()=>({
 job:ui.job,draft:ui.draft,active:false,submitting:false,unresolved:ui.unresolved,recoveryBlocked:ui.recoveryBlocked,
 submit:ui.submit,retrySaved:ui.retrySaved,reset:ui.reset,recheck:vi.fn(),retryRecovery:vi.fn(),
})}));
vi.mock('../src/modules/Store/packaging/useSourceUpload',()=>({useSourceUpload:()=>({
 scope:ui.scope,upload:ui.upload,intent:ui.intent,busy:ui.uploadBusy,phase:ui.phase,percent:0,error:'',
 select:ui.select,cancel:ui.cancel,recheck:ui.recheck,forget:ui.forget,restore:ui.restore,retryRecovery:vi.fn(),
})}));
vi.mock('../src/modules/Store/packaging/useNpmMetadata',()=>({useNpmMetadata:()=>({metadata:ui.npmMetadata,resolve:ui.resolve})}));
vi.mock('../src/modules/Store/packaging/useRepositoryMetadata',()=>({useRepositoryMetadata:()=>({resolve:vi.fn()})}));
vi.mock('../src/modules/Store/packaging/PackagingBuildStatus',()=>({PackagingBuildStatus:()=>null}));
vi.mock('../src/modules/Store/packaging/SourceFilesPicker',()=>({SourceFilesPicker:()=>null}));
vi.mock('@ant-design/icons',()=>({FileZipOutlined:()=>null,FolderOpenOutlined:()=>null,UploadOutlined:()=>null}));
vi.mock('antd',()=>{
 const content=({children}:{children?:ReactNode})=>children;
 const input=(props:InputProps)=>{ui.inputs.set(props['aria-label']??'',props);return null;};
 return {
  Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),
  Button:(props:ButtonProps)=>{ui.buttons.set(String(props.children),props);return props.children;},
  Modal:({open,onCancel,children,footer}:{open:boolean;onCancel:()=>void;children?:ReactNode;footer?:ReactNode})=>{ui.close=onCancel;return open?createElement('div',null,children,footer):null;},
  Form:Object.assign(({children,onFinish,disabled}:{children?:ReactNode;onFinish:()=>void;disabled:boolean})=>{ui.finish=onFinish;ui.formDisabled=disabled;return children;},{Item:content}),
  Input:Object.assign(input,{Search:input,TextArea:input}),
  Radio:{Group:({'aria-label':label,value,onChange}:{'aria-label':string;value:string;onChange:typeof ui.selectSource})=>{if(label==='Источник инструмента'){ui.source=value;ui.selectSource=onChange;}return null;}},
  Select:(props:SelectProps)=>{ui.selects.set(props['aria-label']??'',props);return null;},
  Collapse:Object.assign(content,{Panel:content}),Space:content,Progress:()=>null,Spin:()=>null,Tag:content,Divider:content,
  Typography:{Text:content,Paragraph:content},
 };
});
import {ToolPackagingModal} from '../src/modules/Store/packaging/ToolPackagingModal';

const intent:SourceUploadIntent={requestKey:'11111111-1111-4111-8111-111111111111',name:'server.zip',bytes:100,sha256:'a'.repeat(64)};
const readyUpload=():SourceUpload=>({id:'22222222-2222-4222-8222-222222222222',...intent,state:'READY',expiresAt:'2027-01-01',metadata:{
 candidates:['bin/first','bin/second'],entrypoint:'',requiresEntrypointChoice:true,runnableKinds:['mcp'],
 choices:[{entrypoint:'bin/first',adapter:'native',targets:['linux-x64']},{entrypoint:'bin/second',adapter:'native',targets:['darwin-arm64']}],
}});
const succeeded=():ToolBuild=>({id:'built',operationId:'operation',state:'SUCCEEDED',percent:100,message:'Готово',result:{catalogId:'tool',name:'Tool',version:1}});
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function render(){
 hooks.begin();ui.inputs.clear();ui.buttons.clear();ui.selects.clear();ui.finish=undefined;
 const html=renderToStaticMarkup(createElement(ToolPackagingModal,{open:ui.open,scope:ui.scope,projectId:ui.projectId,onClose:()=>{ui.open=false;},onPublished:vi.fn()}));
 hooks.commit();return html;
}
function changeInput(label:string,value:string){ui.inputs.get(label)!.onChange!({target:{value}});}
function ready(){
 render();ui.selectSource!({target:{value:'upload'}});ui.upload=readyUpload();ui.intent=intent;render();
 ui.selects.get('Файл запуска')!.onChange('bin/second');render();
 changeInput('Название в каталоге','Мой MCP');changeInput('Описание инструмента','Нужное описание');render();
}
beforeEach(()=>{
 hooks.dispose();vi.resetAllMocks();ui.scope='actor-a:main-admin';ui.projectId='project-a';ui.open=true;ui.epoch=0;ui.owners.clear();
 ui.job=undefined;ui.draft=undefined;ui.unresolved=false;ui.recoveryBlocked=false;ui.npmMetadata=undefined;ui.upload=undefined;ui.intent=undefined;ui.uploadBusy=false;ui.phase='idle';
 ui.reset.mockImplementation(async()=>{ui.job=undefined;ui.draft=undefined;return true;});
 ui.forget.mockImplementation(async()=>{ui.upload=undefined;ui.intent=undefined;return true;});
 ui.restore.mockResolvedValue(undefined);ui.resolve.mockResolvedValue(undefined);
 uploadIO.stored.clear();uploadIO.read.mockImplementation(async(scope:string)=>uploadIO.stored.get(scope));
 uploadIO.save.mockImplementation(async(scope:string,value:SourceUploadIntent)=>{uploadIO.stored.set(scope,value);return value;});
 uploadIO.clear.mockImplementation(async(scope:string,key:string)=>{if(uploadIO.stored.get(scope)?.requestKey!==key)return false;uploadIO.stored.delete(scope);return true;});
 uploadIO.cancel.mockResolvedValue({state:'CANCELLED'});
});
afterEach(()=>hooks.dispose());

describe('Ready upload wiring in the actual packaging Modal',()=>{
 it('Does not select the first candidate or submit automatically; explicit second entry survives in the exact request',async()=>{
  render();ui.selectSource!({target:{value:'upload'}});ui.upload=readyUpload();ui.intent=intent;render();
  expect(ui.selects.get('Файл запуска')?.value).toBeUndefined();expect(ui.buttons.get('Выберите команду запуска')?.disabled).toBe(true);
  ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
  ui.selects.get('Файл запуска')!.onChange('bin/second');render();expect(ui.submit).not.toHaveBeenCalled();
  ui.finish!();await flush();
  expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'mcp',source:{type:'upload',uploadId:ui.upload.id,sha256:intent.sha256,bytes:100,entrypoint:'bin/second'}}));
  expect(ui.select).not.toHaveBeenCalled();expect(ui.restore).not.toHaveBeenCalled();
 });
 it('A selection from an old upload is not applied to a replacement UUID',()=>{
  ready();ui.upload={...readyUpload(),id:'33333333-3333-4333-8333-333333333333'};render();
  expect(ui.selects.get('Файл запуска')?.value).toBeUndefined();expect(ui.buttons.get('Выберите команду запуска')?.disabled).toBe(true);
 });
 it.each(['hashing','creating','uploading','recovering'] as const)('Keeps cancellation and Modal close available while %s blocks the form',async phase=>{
  ready();ui.uploadBusy=true;ui.phase=phase;render();
  expect(ui.formDisabled).toBe(true);expect(ui.buttons.get('Отменить загрузку')?.disabled).toBe(false);expect(ui.buttons.get('Закрыть')?.disabled).toBe(false);
  ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
  ui.buttons.get('Отменить загрузку')!.onClick!();expect(ui.cancel).toHaveBeenCalledOnce();
  ui.close!();expect(ui.open).toBe(false);expect(ui.select).not.toHaveBeenCalled();
 });
 it('Restores an exact saved upload request without POST or binary reupload and locks its form',async()=>{
  const source={type:'upload' as const,uploadId:readyUpload().id,sha256:intent.sha256,bytes:100,entrypoint:'bin/second'};
  ui.draft={schemaVersion:1,scope:ui.scope,request:{requestKey:'44444444-4444-4444-8444-444444444444',kind:'mcp',name:'Сохранённый MCP',description:'Сохранённое описание',source}};ui.unresolved=true;
  render();await flush();render();
  expect(ui.restore).toHaveBeenCalledExactlyOnceWith(source);expect(ui.source).toBe('upload');expect(ui.formDisabled).toBe(true);
  expect(ui.inputs.get('Название в каталоге')?.value).toBe('Сохранённый MCP');
  expect(ui.select).not.toHaveBeenCalled();expect(ui.submit).not.toHaveBeenCalled();expect(ui.retrySaved).not.toHaveBeenCalled();
  ui.buttons.get('Повторить сохранённый запрос')!.onClick!();await flush();expect(ui.retrySaved).toHaveBeenCalledOnce();expect(ui.submit).not.toHaveBeenCalled();
 });
 it('Awaited build reset and upload forget still clear the form when forgetting changes its source key',async()=>{
  ready();ui.job=succeeded();render();const cleared=deferred<boolean>();
  ui.forget.mockImplementation(()=>{ui.upload=undefined;ui.intent=undefined;return cleared.promise;});
  ui.buttons.get('Упаковать ещё')!.onClick!();await flush();expect(ui.forget).toHaveBeenCalledOnce();
  render();expect(ui.formDisabled).toBe(true);cleared.resolve(true);await flush();render();
  expect(ui.source).toBe('npm');expect(ui.inputs.get('npm-пакет или ссылка')?.value).toBe('');
  expect(ui.inputs.get('Название в каталоге')?.value).toBe('');expect(ui.inputs.get('Описание инструмента')?.value).toBe('');expect(ui.select).not.toHaveBeenCalled();
 });
 it('A refused durable build reset preserves the original upload and card fields',async()=>{
  ready();ui.job=succeeded();render();ui.reset.mockResolvedValue(false);ui.buttons.get('Упаковать ещё')!.onClick!();await flush();
  expect(ui.forget).not.toHaveBeenCalled();expect(ui.upload?.id).toBe(readyUpload().id);
  ui.job=undefined;render();expect(ui.source).toBe('upload');expect(ui.inputs.get('Название в каталоге')?.value).toBe('Мой MCP');
 });
 it('A refused upload forget retains editable fields and does not launch another build',async()=>{
  ready();ui.job=succeeded();render();ui.forget.mockResolvedValue(false);ui.buttons.get('Упаковать ещё')!.onClick!();await flush();render();
  expect(ui.source).toBe('upload');expect(ui.inputs.get('Название в каталоге')?.value).toBe('Мой MCP');expect(ui.submit).not.toHaveBeenCalled();
 });
 it('A double reset click before render does not cancel the first accepted reset',async()=>{
  ready();ui.job=succeeded();render();const pending=deferred<boolean>();
  ui.reset.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(false);
  const click=ui.buttons.get('Упаковать ещё')!.onClick!;click();click();
  ui.job=undefined;pending.resolve(true);await flush();render();
  expect(ui.forget).toHaveBeenCalledOnce();expect(ui.source).toBe('npm');expect(ui.inputs.get('Название в каталоге')?.value).toBe('');
 });
 it.each(['close','project','actor','role'] as const)('A late durable reset cannot clear another view after %s A → B → A',async change=>{
  ready();ui.job=succeeded();render();const pending=deferred<boolean>();ui.reset.mockReturnValue(pending.promise);
  ui.buttons.get('Упаковать ещё')!.onClick!();
  if(change==='close'){ui.close!();render();ui.open=true;render();}
  else if(change==='project'){ui.projectId='project-b';render();ui.projectId='project-a';render();}
  else {ui.scope=change==='actor'?'actor-b:main-admin':'actor-a:reader';ui.epoch++;render();ui.scope='actor-a:main-admin';ui.epoch++;render();}
  pending.resolve(true);await flush();expect(ui.forget).not.toHaveBeenCalled();
  ui.job=undefined;render();expect(ui.inputs.get('Название в каталоге')?.value).toBe('Мой MCP');expect(ui.submit).not.toHaveBeenCalled();
 });
 it.each(['close','project','actor','role'] as const)('A late forget cannot clear fresh form fields after %s A → B → A',async change=>{
  ready();ui.job=succeeded();render();const pending=deferred<boolean>();ui.forget.mockReturnValue(pending.promise);
  ui.buttons.get('Упаковать ещё')!.onClick!();await flush();expect(ui.forget).toHaveBeenCalledOnce();render();expect(ui.formDisabled).toBe(true);
  if(change==='close'){ui.close!();ui.open=true;render();}
  else if(change==='project'){ui.projectId='project-b';render();ui.projectId='project-a';render();}
  else {ui.scope=change==='actor'?'actor-b:main-admin':'actor-a:reader';ui.epoch++;render();ui.scope='actor-a:main-admin';ui.epoch++;render();}
  expect(ui.formDisabled).toBe(false);changeInput('Название в каталоге','Новая карточка');render();
  pending.resolve(true);await flush();render();expect(ui.inputs.get('Название в каталоге')?.value).toBe('Новая карточка');expect(ui.submit).not.toHaveBeenCalled();
 });
 it.each(['source','project','actor','role','open'] as const)('A late metadata response cannot POST after %s A → B → A',async change=>{
  const metadata:NpmPackageMetadata={package:'@team/tool',specifier:'@team/tool@1.0.0',version:'1.0.0',description:'Описание',entrypoint:'server.js',candidates:['server.js'],runnableKinds:['mcp']};
  render();changeInput('npm-пакет или ссылка',metadata.package);ui.npmMetadata=metadata;render();
  const response=deferred<NpmPackageMetadata>();ui.resolve.mockReturnValue(response.promise);ui.finish!();
  if(change==='source'){ui.selectSource!({target:{value:'repository'}});render();ui.selectSource!({target:{value:'npm'}});render();}
  else if(change==='project'){ui.projectId='project-b';render();ui.projectId='project-a';render();}
  else if(change==='open'){ui.close!();render();ui.open=true;render();}
  else {ui.scope=change==='actor'?'actor-b:main-admin':'actor-a:reader';ui.epoch++;render();ui.scope='actor-a:main-admin';ui.epoch++;render();}
  response.resolve(metadata);await flush();expect(ui.submit).not.toHaveBeenCalled();
 });
});

describe('Actual upload hook durable boundaries',()=>{
 it('Cancel during durable commit removes the exact late intent before reporting an empty form',async()=>{
  const {useSourceUpload:actualUpload}=await vi.importActual<typeof import('../src/modules/Store/packaging/useSourceUpload')>('../src/modules/Store/packaging/useSourceUpload');
  const capture=()=>{const epoch=ui.epoch;return()=>ui.epoch===epoch;};
  const draw=()=>{hooks.begin();const value=actualUpload(ui.scope,capture);hooks.commit();return value;};
  draw();await flush();
  const saved=deferred<SourceUploadIntent>();uploadIO.save.mockImplementation((scope:string)=>saved.promise.then(value=>{uploadIO.stored.set(scope,value);return value;}));
  const selecting=draw().select(new File(['local source'],'tool.zip'));
  await vi.waitFor(()=>expect(uploadIO.save).toHaveBeenCalledOnce());
  const exact=uploadIO.save.mock.calls[0][1] as SourceUploadIntent;
  const cancelling=draw().cancel();saved.resolve(exact);await Promise.all([selecting,cancelling]);await flush();
  expect(uploadIO.create).not.toHaveBeenCalled();expect(uploadIO.content).not.toHaveBeenCalled();
  expect(uploadIO.stored.get(ui.scope)).toBeUndefined();expect(draw().intent).toBeUndefined();
 });
 it.each(['actor','role'] as const)('A late durable commit after %s A → B → A cannot POST or update the fresh view',async change=>{
  const {useSourceUpload:actualUpload}=await vi.importActual<typeof import('../src/modules/Store/packaging/useSourceUpload')>('../src/modules/Store/packaging/useSourceUpload');
  const owners=new Map<number,()=>()=>boolean>();
  const draw=()=>{if(!owners.has(ui.epoch)){const epoch=ui.epoch;owners.set(epoch,()=>()=>ui.epoch===epoch);}hooks.begin();const value=actualUpload(ui.scope,owners.get(ui.epoch)!);hooks.commit();return value;};
  draw();await flush();const saved=deferred<SourceUploadIntent>();uploadIO.save.mockReturnValue(saved.promise);
  const selecting=draw().select(new File(['local source'],'tool.zip'));await vi.waitFor(()=>expect(uploadIO.save).toHaveBeenCalledOnce());
  const exact=uploadIO.save.mock.calls[0][1] as SourceUploadIntent;
  ui.scope=change==='actor'?'actor-b:main-admin':'actor-a:reader';ui.epoch++;draw();await flush();ui.scope='actor-a:main-admin';ui.epoch++;draw();await flush();
  saved.resolve(exact);await selecting;
  expect(uploadIO.create).not.toHaveBeenCalled();expect(uploadIO.content).not.toHaveBeenCalled();expect(draw().intent).toBeUndefined();
 });
});
