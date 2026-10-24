import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys,type IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import {ToolPackagingModal} from '../src/modules/Store/packaging/ToolPackagingModal';
import type {NpmPackageMetadata,RepositoryMetadata,ToolBuildRequest} from '../src/modules/Store/packaging/types';
import type {SourceUpload} from '../src/modules/Store/packaging/uploadTypes';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;dependencies?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a?:unknown[],b?:unknown[])=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return [slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial?:T){return (slots[cursor++]??={value:{current:initial}}).value;},
        useMemo(factory:()=>unknown,dependencies:unknown[]){const index=cursor++,old=slots[index];if(!old||!same(old.dependencies,dependencies))slots[index]={value:factory(),dependencies};return slots[index].value;},
        useEffect(effect:()=>void|(()=>void),dependencies:unknown[]){const index=cursor++,old=slots[index];if(old&&same(old.dependencies,dependencies))return;const slot=slots[index]={dependencies};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
interface SelectProps {'aria-label'?:string;value?:string[];options?:Array<{value:string;label:string}>;disabled?:boolean;onChange:(values:string[])=>void}
interface InputProps {'aria-label'?:string;value?:string;onChange?:(event:{target:{value:string}})=>void;onSearch?:()=>void}
const ui=vi.hoisted(()=>({scope:'admin-a',projectId:'project-a',open:true,enabled:true,unresolved:false,recovering:false,active:false,realMetadata:false,
    draft:undefined as {request:ToolBuildRequest}|undefined,metadata:undefined as NpmPackageMetadata|undefined,repository:undefined as RepositoryMetadata|undefined,upload:undefined as SourceUpload|undefined,
    uploadEntry:undefined as ((value:string)=>void)|undefined,
    inputs:new Map<string,InputProps>(),selects:new Map<string,SelectProps>(),buttons:new Map<string,{disabled?:boolean;onClick?:()=>void}>(),
    source:undefined as ((event:{target:{value:string}})=>void)|undefined,kind:undefined as ((event:{target:{value:string}})=>void)|undefined,
    finish:undefined as (()=>void)|undefined,submit:vi.fn(),retrySaved:vi.fn(),resolve:vi.fn(),owners:new Map<string,()=>()=>boolean>(),
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useMemo:hooks.useMemo,useEffect:hooks.useEffect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{if(!ui.owners.has(ui.scope)){const scope=ui.scope;ui.owners.set(scope,()=>()=>ui.scope===scope);}return {captureOwner:ui.owners.get(ui.scope)!};}}));
vi.mock('../src/modules/Store/packaging/useNpmMetadata',async original=>{const actual=await original<typeof import('../src/modules/Store/packaging/useNpmMetadata')>();return {useNpmMetadata:(specifier:string)=>ui.realMetadata?actual.useNpmMetadata(specifier):{metadata:ui.metadata,resolve:ui.resolve}};});
vi.mock('../src/modules/Store/packaging/api',()=>({packagingApi:{npm:(...args:unknown[])=>ui.resolve(...args)}}));
vi.mock('../src/modules/Store/packaging/useRepositoryMetadata',()=>({useRepositoryMetadata:()=>({metadata:ui.repository,resolve:async()=>ui.repository})}));
vi.mock('../src/modules/Store/packaging/useToolBuild',()=>({useToolBuild:()=>({draft:ui.draft,active:ui.active,unresolved:ui.unresolved,recovering:ui.recovering,submit:ui.submit,retrySaved:ui.retrySaved})}));
vi.mock('../src/modules/Store/packaging/usePackagingAgent',()=>({usePackagingAgent:()=>({checked:false,restore:()=>{},clear:()=>{}})}));
vi.mock('../src/modules/Store/packaging/PackagingAgentOptions',()=>({PackagingAgentOptions:()=>null}));
vi.mock('../src/modules/Store/packaging/usePackagingPublication',()=>({usePackagingPublication:()=>({restore:()=>{},clear:()=>{}})}));
vi.mock('../src/modules/Store/packaging/PackagingPublicationPanel',()=>({PackagingPublicationPanel:()=>null}));
vi.mock('../src/modules/Store/packaging/useSourceUpload',()=>({useSourceUpload:()=>({busy:false,upload:ui.upload,restore:async()=>{}})}));
vi.mock('../src/modules/Store/packaging/SourceArchiveUploader',()=>({SourceArchiveUploader:({onEntrypointChange}:{onEntrypointChange:(value:string)=>void})=>{ui.uploadEntry=onEntrypointChange;return null;}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children,input=(props:InputProps)=>{ui.inputs.set(props['aria-label']??'',props);return null;};
    return {Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),
        Button:({children,...props}:{children?:ReactNode;disabled?:boolean;onClick?:()=>void})=>{ui.buttons.set(String(children),props);return children;},
        Select:(props:SelectProps)=>{ui.selects.set(props['aria-label']??'',props);return null;},
        Modal:({open,children,footer}:{open:boolean;children?:ReactNode;footer?:ReactNode})=>open?createElement('div',null,children,footer):null,
        Form:Object.assign(({children,onFinish}:{children?:ReactNode;onFinish:()=>void})=>{ui.finish=onFinish;return children;},{Item:({children,label,help}:{children?:ReactNode;label?:ReactNode;help?:ReactNode})=>createElement('div',null,label,children,help)}),
        Input:Object.assign(input,{Search:input,TextArea:input}),Radio:{Group:({'aria-label':label,onChange}:{'aria-label':string;onChange:typeof ui.source})=>{if(label==='Источник инструмента')ui.source=onChange;else if(label==='Тип инструмента')ui.kind=onChange;return null;}},
        Space:content,Collapse:Object.assign(content,{Panel:content}),Typography:{Paragraph:content,Text:content},Tag:content,Tooltip:content,Progress:()=>null,Spin:()=>null,
    };
});
const metadata:NpmPackageMetadata={package:'opencode-rag-plugin',version:'2.4.4',specifier:'opencode-rag-plugin@2.4.4',entrypoint:'index.js',candidates:['index.js'],description:'RAG',recommendedKind:'plugin',supportedTargets:['darwin-arm64','linux-x64-glibc']};
const flush=async()=>{for(let turn=0;turn<10;turn++)await Promise.resolve();};
function render(){hooks.begin();ui.inputs.clear();ui.selects.clear();ui.buttons.clear();const data={flags:Object.fromEntries(featureFlagKeys.map(key=>[key,ui.enabled])),configured:{},blockedBy:Object.fromEntries(featureFlagKeys.map(key=>[key,[]]))} as IEvaluatedFeatureFlags;
    const html=renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider,{value:{data,loading:false,error:null,refresh:async()=>undefined}},createElement(ToolPackagingModal,{open:ui.open,scope:ui.scope,projectId:ui.projectId,onClose:()=>{ui.open=false;},onPublished:async()=>{}})));hooks.commit();return html;}
function input(label:string,value:string){ui.inputs.get(label)!.onChange!({target:{value}});}
function ready(){render();input('npm-пакет или ссылка',metadata.package);ui.metadata={...metadata};render();render();}
beforeEach(()=>{vi.resetAllMocks();ui.scope='admin-a';ui.projectId='project-a';ui.open=true;ui.enabled=true;ui.unresolved=false;ui.recovering=false;ui.active=false;ui.realMetadata=false;ui.draft=undefined;ui.metadata=undefined;ui.repository=undefined;ui.upload=undefined;ui.owners.clear();ui.resolve.mockImplementation(async()=>ui.metadata);});
afterEach(()=>hooks.dispose());

describe('Выбор платформ реального упаковщика',()=>{
    it('Показывает поддерживаемые платформы и отправляет только выбранный Apple Silicon',async()=>{
        ready();const choice=ui.selects.get('Платформы сборки');expect(choice).toBeDefined();expect(choice!.options).toEqual([{value:'darwin-arm64',label:'macOS · Apple Silicon'},{value:'linux-x64-glibc',label:'Linux · x64 · glibc'}]);
        choice!.onChange(['darwin-arm64']);render();ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({targets:['darwin-arm64'],source:{type:'npm',specifier:metadata.specifier,entrypoint:'index.js'}}));
    });
    it('Нетронутый выбор сохраняет старое тело без targets; явный возврат ко всем также опускает поле',async()=>{
        ready();ui.finish!();await flush();expect(ui.submit.mock.calls[0][0]).not.toHaveProperty('targets');
        render();ui.selects.get('Платформы сборки')!.onChange(['darwin-arm64']);render();ui.buttons.get('Все платформы источника')!.onClick!();render();ui.finish!();await flush();expect(ui.submit.mock.calls[1][0]).not.toHaveProperty('targets');
    });
    it('Обычный npm без списка платформ предлагает глобальный набор API и сохраняет default omission',async()=>{
        ready();ui.metadata={...metadata,supportedTargets:undefined};render();expect(ui.selects.get('Платформы сборки')!.options).toHaveLength(8);ui.finish!();await flush();expect(ui.submit.mock.calls[0][0]).not.toHaveProperty('targets');
    });
    it('Пустой явный выбор блокирует кнопку и Enter; исправление сохраняет выбранную платформу',async()=>{
        ready();ui.selects.get('Платформы сборки')!.onChange([]);expect(render()).toContain('Выберите хотя бы одну платформу');expect(ui.buttons.get('Упаковать и добавить')?.disabled).toBe(true);
        ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();render();ui.selects.get('Платформы сборки')!.onChange(['darwin-arm64']);render();ui.finish!();await flush();expect(ui.submit.mock.calls[0][0].targets).toEqual(['darwin-arm64']);
    });
    it('Изменившаяся поддержка не превращает явный выбор во все платформы, включая свежую resolve-проверку',async()=>{
        ready();ui.selects.get('Платформы сборки')!.onChange(['darwin-arm64']);render();ui.resolve.mockResolvedValue({...metadata,supportedTargets:['linux-x64-glibc']});ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();expect(render()).toContain('Выбранная платформа недоступна');
        ui.metadata={...metadata,supportedTargets:['linux-x64-glibc']};render();expect(ui.selects.get('Платформы сборки')!.value).toEqual(['darwin-arm64']);ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
    });
    it.each(['same','unsupported'] as const)('Перепроверка того же источника через loading сохраняет явные платформы при %s ответе',async response=>{
        ui.realMetadata=true;ui.resolve.mockResolvedValueOnce(metadata);render();input('npm-пакет или ссылка',metadata.package);render();ui.inputs.get('npm-пакет или ссылка')!.onSearch!();await flush();render();render();
        ui.selects.get('Платформы сборки')!.onChange(['darwin-arm64']);render();let resolve!:(value:NpmPackageMetadata)=>void;ui.resolve.mockReturnValueOnce(new Promise<NpmPackageMetadata>(done=>{resolve=done;}));
        ui.inputs.get('npm-пакет или ссылка')!.onSearch!();await flush();render();expect(ui.selects.has('Платформы сборки')).toBe(false);
        resolve({...metadata,supportedTargets:response==='same'?metadata.supportedTargets:['linux-x64-glibc']});await flush();render();render();expect(ui.selects.get('Платформы сборки')!.value).toEqual(['darwin-arm64']);ui.finish!();await flush();
        if(response==='same')expect(ui.submit.mock.calls[0][0].targets).toEqual(['darwin-arm64']);else expect(ui.submit).not.toHaveBeenCalled();
    });
    it.each(['source','kind','scope','project'] as const)('Смена %s очищает локальный выбор; устаревший обработчик не возвращает его',async change=>{
        ready();const old=ui.selects.get('Платформы сборки')!;old.onChange(['darwin-arm64']);render();
        if(change==='source'){input('npm-пакет или ссылка','another-tool');ui.metadata={...metadata,package:'another-tool',specifier:'another-tool@1.0.0',supportedTargets:['linux-x64-glibc']};}
        else if(change==='kind')ui.kind!({target:{value:'mcp'}});else if(change==='scope')ui.scope='admin-b';else ui.projectId='project-b';
        render();render();old.onChange(['darwin-arm64']);render();ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledOnce();expect(ui.submit.mock.calls[0][0]).not.toHaveProperty('targets');
    });
    it('Переход npm → GitHub использует платформы нового источника, без старой macOS',async()=>{
        ready();const old=ui.selects.get('Платформы сборки')!;old.onChange(['darwin-arm64']);render();
        ui.repository={url:'https://github.com/team/native',commit:'a'.repeat(40),ref:'main',entrypoint:'server.js',candidates:['server.js'],name:'Native',description:'Native',recommendedKind:'mcp',supportedTargets:['linux-x64-glibc']};ui.source!({target:{value:'repository'}});render();render();input('Ссылка на репозиторий GitHub',ui.repository.url);render();
        old.onChange(['darwin-arm64']);render();const choice=ui.selects.get('Платформы сборки')!;expect(choice.value).toEqual([]);expect(choice.options?.map(option=>option.value)).toEqual(['linux-x64-glibc']);choice.onChange(['linux-x64-glibc']);render();ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({targets:['linux-x64-glibc'],source:expect.objectContaining({type:'repository',ref:'a'.repeat(40)})}));
    });
    it('Архив использует платформы выбранной программы; другая команда не наследует явный набор',async()=>{
        render();ui.upload={id:'22222222-2222-4222-8222-222222222222',requestKey:'33333333-3333-4333-8333-333333333333',name:'native.zip',sha256:'a'.repeat(64),bytes:123,state:'READY',expiresAt:'2026-10-25',metadata:{entrypoint:'mac/server',candidates:['mac/server','linux/server'],requiresEntrypointChoice:true,runnableKinds:['mcp'],choices:[{entrypoint:'mac/server',adapter:'native',targets:['darwin-arm64']},{entrypoint:'linux/server',adapter:'native',targets:['linux-x64-glibc']}]}};ui.source!({target:{value:'upload'}});render();
        const old=ui.selects.get('Платформы сборки')!;expect(old.options?.map(option=>option.value)).toEqual(['darwin-arm64']);old.onChange(['darwin-arm64']);render();ui.uploadEntry!('linux/server');render();old.onChange(['darwin-arm64']);render();
        const fresh=ui.selects.get('Платформы сборки')!;expect(fresh.value).toEqual([]);expect(fresh.options?.map(option=>option.value)).toEqual(['linux-x64-glibc']);fresh.onChange(['linux-x64-glibc']);render();ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({targets:['linux-x64-glibc'],source:expect.objectContaining({type:'upload',entrypoint:'linux/server'})}));
    });
    it('Восстанавливает точный набор при другом metadata, блокирует редактирование и повторяет сохранённый запрос',async()=>{
        const request:ToolBuildRequest={requestKey:'11111111-1111-4111-8111-111111111111',kind:'plugin',name:'Сохранённый RAG',description:'RAG',targets:['darwin-arm64'],source:{type:'npm',specifier:metadata.specifier,entrypoint:'index.js'}};
        ui.draft={request};ui.unresolved=true;ui.metadata={...metadata,supportedTargets:['linux-x64-glibc']};render();render();ui.open=false;render();ui.open=true;render();
        const choice=ui.selects.get('Платформы сборки')!;expect(choice.value).toEqual(request.targets);expect(choice.disabled).toBe(true);choice.onChange(['linux-x64-glibc']);render();expect(ui.selects.get('Платформы сборки')!.value).toEqual(request.targets);
        ui.finish!();await flush();expect(ui.retrySaved).toHaveBeenCalledOnce();expect(ui.submit).not.toHaveBeenCalled();expect(request.targets).toEqual(['darwin-arm64']);
    });
    it('Активная сборка показывает сохранённые платформы без доступного изменения',()=>{
        ui.draft={request:{requestKey:'11111111-1111-4111-8111-111111111111',kind:'mcp',name:'Memory',description:'Memory',targets:['darwin-arm64'],source:{type:'npm',specifier:'memory@1',entrypoint:'index.js'}}};ui.active=true;render();render();expect(ui.selects.get('Платформы сборки')).toMatchObject({value:['darwin-arm64'],disabled:true});
    });
    it('Старый запрос без targets восстанавливается в режиме всех платформ; скилл не получает chooser или targets',async()=>{
        ui.draft={request:{requestKey:'11111111-1111-4111-8111-111111111111',kind:'skill',name:'Skill',description:'Skill',source:{type:'repository',url:'https://github.com/team/skill',ref:'a'.repeat(40),entrypoint:'SKILL.md'}}};
        ui.repository={url:'https://github.com/team/skill',commit:'a'.repeat(40),ref:'main',entrypoint:'SKILL.md',candidates:['SKILL.md'],name:'Skill',description:'Skill',recommendedKind:'skill'};render();render();expect(ui.selects.has('Платформы сборки')).toBe(false);
        ui.draft=undefined;render();ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledOnce();expect(ui.submit.mock.calls[0][0]).not.toHaveProperty('targets');
    });
});
