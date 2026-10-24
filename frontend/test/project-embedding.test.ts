import './feature-flags-enabled';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import base from '../src/core/api/base';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
import type {ICatalogModel,IModelCatalog} from '../src/features/ModelCatalog/types';
import {ProjectEmbedding,ProjectEmbeddingContent} from '../src/features/ProjectEmbedding/ProjectEmbedding';
import {ProjectEmbeddingConnection,ConnectEmbeddingAction} from '../src/features/ProjectEmbedding/ProjectEmbeddingConnection';
import {EmbeddingTargetFields,useEmbeddingTarget} from '../src/features/ProjectEmbedding/EmbeddingTarget';
import {embeddingConnectionInput} from '../src/features/ProjectEmbedding/connection';
import {requireProjectEmbedding,type IProjectEmbedding} from '../src/features/ProjectEmbedding/model';
import type {IProjectReindexPlan} from '../src/features/ProjectEmbedding/reindex';
import {bridgeApi,type IBridgeJob} from '../src/features/McpBridge/api';
import {ragUiFixture} from './ragUiFixture';

// Настоящие компоненты, read/save hook и useLocalJob; управляются только lifecycle и HTTP.
const hooks=vi.hoisted(()=>{
    let cursor=0;
    const slots:Array<{value?:unknown;dependencies?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),
        dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial?:T|(()=>T)){const slot=slots[cursor++]??={value:typeof initial==='function'?(initial as ()=>T)():initial};return[slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useCallback<T>(value:T,deps:unknown[]){const index=cursor++,previous=slots[index];if(!previous||!same(previous.dependencies,deps))slots[index]={value,dependencies:deps};return slots[index].value;},
        useEffect(effect:()=>void|(()=>void),deps?:unknown[]){const index=cursor++,previous=slots[index];if(previous&&deps&&same(previous.dependencies,deps))return;const slot=slots[index]={dependencies:deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
interface Button{children:ReactNode;disabled?:boolean;onClick?:()=>void;href?:string;}
interface Choice{value?:string;disabled?:boolean;onChange:(id?:string)=>void;options:Array<{value:string;label:string}>;}
interface Consent{checked:boolean;disabled?:boolean;onChange:(event:{target:{checked:boolean}})=>void;}
const ui=vi.hoisted(()=>({scope:'owner-a',epoch:0,buttons:new Map<string,Button>(),choices:new Map<string,Choice>(),consent:undefined as Consent|undefined,
    bridge:undefined as ReturnType<typeof ragUiFixture>['bridge']|undefined,
    ragUi:undefined as {bridge:ReturnType<typeof ragUiFixture>['bridge'];projectId:string;canWrite:boolean}|undefined,
    owners:new Map<string,()=>()=>boolean>(),prefer:vi.fn(),
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,useEffect:hooks.useEffect}));
vi.mock('react-redux',()=>({useSelector:()=>({email:'admin@example.test',activeRole:'Главный админ',userRoles:['Главный админ']})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    const scope=ui.scope,epoch=ui.epoch,key=JSON.stringify([scope,epoch]);
    if(!ui.owners.has(key))ui.owners.set(key,()=>()=>scope===ui.scope&&epoch===ui.epoch);
    return{scope,captureOwner:ui.owners.get(key)!};
}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),patch:vi.fn(),post:vi.fn()}}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{list:vi.fn()}}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{create:vi.fn()}}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>ui.bridge}));
vi.mock('../src/features/McpBridge/ragUi/OpenCodeRagUi',()=>({OpenCodeRagUi:(props:NonNullable<typeof ui.ragUi>)=>{ui.ragUi=props;return 'Управление индексом выбранной установки';}}));
vi.mock('antd',async()=>{
    const{createElement:h}=await import('react');const content=({children}:{children?:ReactNode})=>children;
    return{Space:({id,children}:{id?:string;children?:ReactNode})=>h('div',{id},children),Card:({id,title,extra,children}:{id?:string;title:ReactNode;extra:ReactNode;children:ReactNode})=>h('div',{id},title,extra,children),
        Spin:()=>null,Progress:({percent}:{percent?:number})=>h('progress',{value:percent,max:100}),Typography:{Paragraph:content,Text:content},
        Alert:({message,description,action}:{message:ReactNode;description?:ReactNode;action?:ReactNode})=>h('div',null,message,description,action),
        Button:(props:Button)=>{if(typeof props.children==='string')ui.buttons.set(props.children,props);return h('button',{disabled:props.disabled},props.children);},
        Select:(props:Choice&{'aria-label':string})=>{ui.choices.set(props['aria-label'],props);return null;},
        Checkbox:(props:Consent&{children:ReactNode})=>{ui.consent=props;return props.children;},
    };
});
const model=(id:string,changes:Partial<ICatalogModel>={}):ICatalogModel=>({id,name:'Модель '+id,description:'',capability:'embedding',runtime:'ollama',model:'qwen3-embedding:4b',
    manifestSha256:'c'.repeat(64),modelPin:(id==='a'?'d':'e').repeat(64),dimension:2560,source:'custom',revision:1,createdAt:'2026-10-20',updatedAt:'2026-10-20',...changes});
let selection:IProjectEmbedding,catalog:IModelCatalog,current:ReturnType<typeof ragUiFixture>,mode:'panel'|'action'|'connection'|'target',canManage:boolean,canConnect:boolean;
let serverProfile:IProjectEmbedding['profile']|undefined;
let actionInput:ReturnType<typeof embeddingConnectionInput>;
let target:ReturnType<typeof useEmbeddingTarget>;
function TargetFixture(){target=useEmbeddingTarget('prj-one');return createElement(EmbeddingTargetFields,{target});}
function render(){hooks.begin();ui.buttons.clear();ui.choices.clear();ui.consent=undefined;ui.ragUi=undefined;
    const component=mode==='panel'?createElement(ProjectEmbeddingContent,{projectId:'prj-one',serverHasData:true,indexProfile:serverProfile??selection.profile,canManage,canConnect})
        :mode==='connection'?createElement(ProjectEmbeddingConnection,{selection,disabled:false})
        :mode==='target'?createElement(TargetFixture)
        :createElement(ConnectEmbeddingAction,{input:actionInput,selection,bridge:current.bridge,disabled:false,consent:'Модель А · компьютер А · /fixture/root/Проект',onPreferRagUi:ui.prefer});
    const html=renderToStaticMarkup(component);hooks.commit();return html;
}
async function settle(){for(let i=0;i<12;i++)await Promise.resolve();render();render();}
function button(label:string){const item=ui.buttons.get(label);expect(item,`кнопка ${label}`).toBeDefined();return item!;}
const choice=()=>ui.choices.get('Модель эмбеддингов проекта')!;
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const result=()=>({status:'connected',revision:selection.revision,modelPin:selection.modelPin,profile:selection.profile,requiresRestart:true,
    reindex:{complete:true,rowCount:3,snapshotHash:'f'.repeat(64),serverSynced:true}});
const plan=(id='b'):IProjectReindexPlan=>({id:'12345678-1234-4234-8234-123456789012',projectId:'prj-one',state:'applied',digest:'c'.repeat(64),approved:true,progress:100,message:'Готово',createdAt:'2026-10-20T00:00:00Z',
    data:{context:{revision:selection.revision,generation:selection.activeGeneration,dataRevision:selection.dataRevision},modelId:id,modelPin:model(id).modelPin!,
        profile:{provider:'openai',model:`neurocenter/${id}/sha256/${model(id).modelPin}`,dimension:model(id).dimension!},sourceSnapshot:null,rowCount:0,requiredBytes:0}});
function job(changes:Partial<IBridgeJob>={}):IBridgeJob{return current.job({kind:'connect-rag-model',...changes});}
function checkedPlugin(){return{...current.item,assetId:'rag-plugin',assetKind:'plugin' as const,
    inspection:{...current.item.inspection!,assetId:'rag-plugin',assetKind:'plugin' as const}};}
function consent(){render();expect(ui.consent?.checked).toBe(false);ui.consent!.onChange({target:{checked:true}});render();}
beforeEach(()=>{
    vi.resetAllMocks();mode='panel';canManage=true;canConnect=false;serverProfile=undefined;ui.scope='owner-a';ui.epoch=0;ui.owners.clear();
    current=ragUiFixture();ui.bridge=current.bridge;current.device.report.root='/fixture/root';current.device.report.capabilities!.push('project-rag-generations-v1','hosted-rag-reindex-v1','hosted-rag-grants-v1','hosted-rag-profile-values-v1');
    current.item.hostedEmbedding={supported:true,reindexSupported:true};current.item.inspection={schemaVersion:1,projectId:current.item.projectId,bindingId:current.binding.bindingId,assetId:current.item.assetId,
        assetKind:current.item.assetKind,version:current.item.version,manifest:current.item.manifest,checkedAt:'2026-10-20T01:00:00Z',readiness:'unverified',state:'checked',status:'synced',issues:[]};
    selection={projectId:'prj-one',revision:2,expectedDimension:2560,model:model('a'),modelPin:'d'.repeat(64),profile:{provider:'openai',model:`neurocenter/a/sha256/${'d'.repeat(64)}`,dimension:2560},activeGeneration:'initial-'+'a'.repeat(32),activeSnapshot:null,dataRevision:0};
    catalog={items:[model('a'),model('b'),model('wrong',{dimension:384}),model('chat',{capability:'chat'}),model('unassigned'),model('unsealed',{manifestSha256:null})],assignedModelIds:['a','b','wrong','chat','unsealed']};
    vi.mocked(base.get).mockImplementation(async url=>({data:String(url).endsWith('/reindex')?null:selection}));
    vi.mocked(base.patch).mockImplementation(async()=>({data:{...selection,revision:3,model:null,modelPin:null,profile:null}}));
    vi.mocked(base.post).mockImplementation(async(_url,body)=>{const next=plan((body as {modelId:string}).modelId);selection={...selection,revision:selection.revision+1,model:model(next.data.modelId),modelPin:next.data.modelPin,profile:next.data.profile};return{data:next};});
    vi.mocked(modelCatalogApi.list).mockResolvedValue(catalog);vi.mocked(bridgeApi.create).mockResolvedValue(job());
    actionInput=embeddingConnectionInput(current.item,current.binding,selection);
});
afterEach(()=>hooks.dispose());

describe('Продолжение подготовки локального embedding target',()=>{
    it('Установленный OpenCodeRAG с точной ожидающей сверкой показывает проверку вместо повторной установки',async()=>{
        mode='target';current.bridge.installations=[{...current.item,inspection:undefined}];
        for(const state of ['queued','running','reconciling']){
            current.bridge.jobs=[job({kind:'inspect-installation',state})];const html=render();
            expect(html).toContain('OpenCodeRAG установлен. Проверяем файлы');expect(target.blocked).toBe(true);expect(target.value).toBeUndefined();
            expect(ui.buttons.has('Установить OpenCodeRAG')).toBe(false);expect(button('Ход проверки').href).toBe('/operations');expect(ui.buttons.has('Обновить установки')).toBe(true);
        }
        expect(base.post).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();
        current.bridge.jobs=[job({kind:'inspect-installation',state:'succeeded'})];current.bridge.installations=[current.item];
        expect(render()).not.toContain('OpenCodeRAG установлен. Проверяем файлы');expect(target.blocked).toBe(false);expect(target.value?.expectedManifest).toBe(current.item.manifest);
    });
    it('Сверка другой установки не скрывает stale выбранную цель и не подставляет её пакет',()=>{
        mode='target';render();expect(target.value?.assetId).toBe(current.item.assetId);
        const plugin={...checkedPlugin(),inspection:undefined};current.bridge.installations=[{...current.item,inspection:undefined},plugin];
        current.bridge.jobs=[job({kind:'inspect-installation',assetId:plugin.assetId,assetKind:plugin.assetKind})];
        expect(render()).not.toContain('OpenCodeRAG установлен. Проверяем файлы');expect(target.item?.assetId).toBe(current.item.assetId);expect(target.value).toBeUndefined();
        current.bridge.jobs=[job({kind:'inspect-installation'})];expect(render()).toContain('OpenCodeRAG установлен. Проверяем файлы');
        expect(target.item?.assetId).toBe(current.item.assetId);expect(target.value).toBeUndefined();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Чужие, старые и завершённые задания не становятся текущей проверкой файлов',()=>{
        mode='target';current.bridge.installations=[{...current.item,inspection:undefined}];
        for(const patch of [{deviceId:'other-device'},{projectId:'prj-other'},{bindingId:'9'.repeat(64)},{assetId:'other-tool'},{assetKind:'plugin'},
            {version:String(current.item.version+1)},{expectedManifest:'9'.repeat(64)},{expectedManifest:undefined},{kind:'install'},{kind:'probe-runtime'},
            {state:'failed'},{state:'cancelled'},{state:'succeeded'}]){
            current.bridge.jobs=[job({kind:'inspect-installation',...patch})];expect(render()).not.toContain('OpenCodeRAG установлен. Проверяем файлы');
            expect(target.blocked).toBe(true);expect(ui.buttons.has('Установить OpenCodeRAG')).toBe(true);
        }
        current.bridge.jobs=[job({kind:'inspect-installation'})];
        for(const patch of [{bindingChanged:true},{legacyBinding:true},{isCurrentBinding:false},{hostedEmbedding:undefined}]){
            current.bridge.installations=[{...current.item,inspection:undefined,...patch}];expect(render()).not.toContain('OpenCodeRAG установлен. Проверяем файлы');
        }
        expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Сверка соседнего пакета не закрывает уже выбранную проверенную альтернативу',()=>{
        mode='target';const plugin={...checkedPlugin(),inspection:undefined};current.bridge.installations=[current.item,plugin];
        current.bridge.jobs=[job({kind:'inspect-installation',assetId:plugin.assetId,assetKind:plugin.assetKind})];
        expect(render()).not.toContain('OpenCodeRAG установлен. Проверяем файлы');expect(target.blocked).toBe(false);expect(target.value?.assetId).toBe(current.item.assetId);
        expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Отсутствующая и ещё не проверенная установка дают каталог и обновление, а проверенный receipt открывает точную локальную цель',async()=>{
        mode='target';current.bridge.installations=[];const reload=vi.spyOn(current.bridge,'reload');render();
        expect(target.blocked).toBe(true);expect(button('Установить OpenCodeRAG').href).toBe('/store?q=OpenCodeRAG+%28%D0%BF%D0%BB%D0%B0%D0%B3%D0%B8%D0%BD%29&p=prj-one');
        button('Обновить установки').onClick!();await settle();expect(reload).toHaveBeenCalledOnce();
        current.bridge.installations=[{...current.item,inspection:undefined}];render();expect(target.blocked).toBe(true);expect(ui.buttons.has('Установить OpenCodeRAG')).toBe(true);
        current.bridge.installations=[current.item];render();expect(target.blocked).toBe(false);expect(target.value).toMatchObject({assetId:current.item.assetId,expectedManifest:current.item.manifest,expectedBindingId:current.binding.bindingId});
        expect(base.post).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Исчезновение выбранной A не подставляет sole B и оставляет явный выбор B',()=>{
        mode='target';const plugin=checkedPlugin();current.bridge.installations=[current.item,plugin];render();
        const choose=()=>ui.choices.get('Установка для новой модели')!;choose().onChange(choose().options[0].value);render();expect(target.value?.assetId).toBe(current.item.assetId);
        current.bridge.installations=[plugin];render();expect(target.blocked).toBe(true);expect(target.value).toBeUndefined();
        expect(choose()).toBeDefined();expect(choose().options[0]).toMatchObject({disabled:true});
        const available=choose().options.find(option=>option.value!==choose().value)!;choose().onChange(available.value);render();
        expect(target.value).toMatchObject({assetId:plugin.assetId,expectedManifest:plugin.manifest});expect(target.blocked).toBe(false);expect(base.post).not.toHaveBeenCalled();
    });
    it('Явный серверный выбор не требует локальной установки и честно объясняет отсутствие локального индекса',()=>{
        mode='target';current.bridge.installations=[];render();ui.choices.get('Область подключения модели')!.onChange('server');const html=render();
        expect(target.blocked).toBe(false);expect(target.value).toBeUndefined();expect(html).toContain('Локальный индекс не создаётся');
        expect(base.post).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Старый мост и неподтверждённая привязка показывают свой следующий шаг, а не установку пакета',()=>{
        mode='target';current.bridge.installations=[];current.device.report.capabilities=current.device.report.capabilities!.filter(value=>value!=='hosted-rag-grants-v1');render();
        expect(button('Обновить мост').href).toBe('/start');expect(ui.buttons.has('Установить OpenCodeRAG')).toBe(false);expect(target.value).toBeUndefined();
        current.device.report.capabilities.push('hosted-rag-grants-v1');current.binding.instanceId='invalid';render();
        expect(button('Связать папку проекта').href).toBe('/projects?bind=prj-one');expect(ui.buttons.has('Установить OpenCodeRAG')).toBe(false);expect(target.value).toBeUndefined();
        expect(base.post).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Ошибка загрузки списка даёт повтор чтения, а две готовые установки требуют выбора вместо переустановки',()=>{
        mode='target';current.bridge.installationsReady=false;current.bridge.error='Список установок недоступен';expect(render()).toContain(current.bridge.error);
        expect(ui.buttons.has('Обновить установки')).toBe(true);expect(ui.buttons.has('Установить OpenCodeRAG')).toBe(false);expect(target.blocked).toBe(true);
        current.bridge.installationsReady=true;current.bridge.error='';current.bridge.installations=[current.item,checkedPlugin()];const html=render();
        expect(html).toContain('Выберите доступную проверенную установку');expect(ui.choices.get('Установка для новой модели')!.value).toBeUndefined();
        expect(ui.buttons.has('Установить OpenCodeRAG')).toBe(false);expect(target.value).toBeUndefined();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
});

describe('Выбор embedding-модели проекта без скрытых операций',()=>{
    it('Ссылка восстановления ведёт к настройке индекса ещё до загрузки модели и без доступной локальной цели',async()=>{
        canConnect=true;current.bridge.installations=[];const held=deferred<{data:IProjectEmbedding}>();vi.mocked(base.get).mockReturnValueOnce(held.promise);
        expect(render()).toContain('id="project-index-settings"');expect(ui.buttons.has('Индексировать проект')).toBe(false);
        held.resolve({data:selection});await settle();expect(render()).toContain('id="project-index-settings"');
        expect(render()).toContain('Модель a');expect(ui.buttons.has('Индексировать проект')).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Загружает выбор и назначенные embedding-модели всех размерностей без запуска операции',async()=>{
        render();await settle();expect(choice().options.map(value=>value.value)).toEqual(['a','b','wrong']);expect(choice().value).toBe('a');
        expect(base.patch).not.toHaveBeenCalled();expect(base.post).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();expect(button('Открыть модели в каталоге проекта').href).toBe('/projects/prj-one?tab=store&catalogTab=models');
    });
    it('Явное подключение создаёт один reindex intent с ревизией и pin, двойной клик не повторяет POST',async()=>{
        render();await settle();choice().onChange('b');render();expect(base.post).not.toHaveBeenCalled();
        const pending=deferred<{data:IProjectReindexPlan}>();vi.mocked(base.post).mockReturnValueOnce(pending.promise);
        const save=button('Подключить модель проекта');save.onClick!();save.onClick!();expect(base.post).toHaveBeenCalledOnce();
        expect(base.post).toHaveBeenCalledWith('/api/projects/prj-one/embedding/reindex',{expectedSelectionRevision:2,expectedModelPin:model('b').modelPin,modelId:'b',requestKey:expect.any(String)});
        const next=plan();selection={...selection,revision:3,model:model('b'),modelPin:next.data.modelPin,profile:next.data.profile};pending.resolve({data:next});await settle();expect(choice().value).toBe('b');expect(button('Подключить модель проекта').disabled).toBe(true);expect(base.patch).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Конфликт не стирает черновик; после чтения выбора следующий явный intent использует новую ревизию',async()=>{
        render();await settle();choice().onChange('b');render();vi.mocked(base.post).mockRejectedValueOnce(new Error('Выбор уже изменён'));
        button('Подключить модель проекта').onClick!();await settle();expect(choice().value).toBe('b');expect(render()).toContain('Выбор уже изменён');
        selection={...selection,revision:7};button('Обновить сведения').onClick!();await settle();expect(choice().value).toBe('b');
        button('Подключить модель проекта').onClick!();await settle();expect(vi.mocked(base.post).mock.calls[1][1]).toEqual({expectedSelectionRevision:7,expectedModelPin:model('b').modelPin,modelId:'b',requestKey:expect.any(String)});
    });
    it('Изменившийся pin той же модели можно закрепить заново без выбора другой модели',async()=>{
        selection={...selection,blocker:'Закреплённая модель изменилась. Выберите её заново.'};render();await settle();
        expect(button('Подключить модель проекта').disabled).toBe(false);button('Подключить модель проекта').onClick!();await settle();
        expect(base.post).toHaveBeenCalledWith('/api/projects/prj-one/embedding/reindex',{expectedSelectionRevision:2,expectedModelPin:model('a').modelPin,modelId:'a',requestKey:expect.any(String)});
    });
    it('Удалённая модель со старым pin и профилем показывается с причиной и допускает очистку выбора',async()=>{
        selection={...selection,model:null,blocker:'Выбранная модель удалена из каталога.'};render();await settle();
        expect(render()).toContain('Выбранная модель удалена из каталога');expect(button('Отключить модель проекта').disabled).toBe(false);
        button('Отключить модель проекта').onClick!();await settle();expect(base.patch).toHaveBeenCalledWith('/api/projects/prj-one/embedding',{expectedRevision:2,modelId:null});expect(base.post).not.toHaveBeenCalled();
    });
    it('Наблюдатель читает модель и несовместимый серверный профиль, но не видит управление',async()=>{
        canManage=false;serverProfile={provider:'ollama',model:'legacy:tag',dimension:2560};render();await settle();const html=render();expect(ui.choices.size).toBe(0);expect(ui.buttons.has('Подключить модель проекта')).toBe(false);
        expect(html).toContain('Модель a');expect(html).toContain('ollama · legacy:tag · 2560');expect(html).toContain('Модель несовместима с существующей серверной копией');expect(html).toContain('команда продолжает работать с текущей');expect(base.patch).not.toHaveBeenCalled();expect(base.post).not.toHaveBeenCalled();
    });
    it('Сбой чтения можно повторить в той же форме без запуска моста',async()=>{
        vi.mocked(base.get).mockRejectedValueOnce(new Error('Сервис недоступен'));render();await settle();expect(render()).toContain('Сервис недоступен');
        button('Повторить загрузку').onClick!();await settle();expect(choice().value).toBe('a');expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Сбой каталога не скрывает свежую сохранённую модель и её подключение, но блокирует изменение выбора',async()=>{
        canConnect=true;vi.mocked(modelCatalogApi.list).mockRejectedValueOnce(new Error('Каталог временно недоступен'));
        render();await settle();expect(render()).toContain('Сохранённая модель');expect(render()).toContain('Модель a');expect(render()).toContain('Каталог временно недоступен');
        expect(render()).not.toContain('Выбранная модель больше не доступна');expect(choice().disabled).toBe(true);expect(button('Подключить модель проекта').disabled).toBe(true);
        button('Подключить модель проекта').onClick!();expect(base.patch).not.toHaveBeenCalled();consent();expect(button('Индексировать проект').disabled).toBe(false);
        expect(bridgeApi.create).not.toHaveBeenCalled();button('Обновить сведения').onClick!();await settle();expect(choice().disabled).toBe(false);
    });
    it('Ошибка авторитетного выбора блокирует подключение даже при доступном каталоге',async()=>{
        canConnect=true;render();await settle();consent();vi.mocked(base.get).mockRejectedValueOnce(new Error('Доступ запрещён'));
        button('Обновить сведения').onClick!();await settle();expect(render()).toContain('Доступ запрещён');expect(button('Индексировать проект').disabled).toBe(true);
        button('Индексировать проект').onClick!();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it.each([401,403,404])('Отказ доступа к каталогу %s не разрешает подключение по предыдущим сведениям',async status=>{
        canConnect=true;vi.mocked(modelCatalogApi.list).mockRejectedValueOnce(Object.assign(new Error('Доступ закрыт'),{isAxiosError:true,response:{status}}));
        render();await settle();consent();expect(button('Индексировать проект').disabled).toBe(true);button('Индексировать проект').onClick!();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Медленный каталог не задерживает чтение модели, а поздний ответ прежнего владельца не меняет новый каталог',async()=>{
        canConnect=true;const old=deferred<IModelCatalog>();vi.mocked(modelCatalogApi.list).mockReturnValueOnce(old.promise);
        render();await settle();expect(render()).toContain('Модель a');expect(choice().disabled).toBe(true);consent();expect(button('Индексировать проект').disabled).toBe(false);
        hooks.dispose();ui.scope='owner-b';selection={...selection,model:model('b')};render();await settle();
        old.resolve({items:[],assignedModelIds:[]});await settle();expect(choice().value).toBe('b');expect(choice().options.map(item=>item.value)).toEqual(['a','b','wrong']);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Поздний GET закрытой формы и save прежнего владельца не подменяют новый выбор',async()=>{
        const old=deferred<{data:IProjectEmbedding}>();vi.mocked(base.get).mockReturnValueOnce(old.promise);render();hooks.dispose();
        selection={...selection,revision:8,model:model('b')};render();await settle();old.resolve({data:{...selection,revision:1,model:model('a')}});await settle();expect(choice().value).toBe('b');
        const save=deferred<{data:IProjectReindexPlan}>();vi.mocked(base.post).mockReturnValueOnce(save.promise);choice().onChange('a');render();button('Подключить модель проекта').onClick!();
        ui.epoch++;hooks.dispose();render();await settle();save.resolve({data:plan('a')});await settle();expect(choice().value).toBe('b');
    });
    it('Ключ формы меняется вместе с проектом и владельцем, технически неполный DTO отклоняется',()=>{
        const first=ProjectEmbedding({projectId:'prj-one',serverHasData:false}).key;ui.scope='owner-b';
        expect(ProjectEmbedding({projectId:'prj-one',serverHasData:false}).key).not.toBe(first);
        expect(ProjectEmbedding({projectId:'prj-two',serverHasData:false}).key).not.toBe(first);
        expect(()=>requireProjectEmbedding({...selection,profile:{...selection.profile!,dimension:384}},'prj-one')).toThrow('неполный');
    });
    it.each(['activeGeneration','activeSnapshot','dataRevision'] as const)('Выбор без %s не считается текущим поколением',field=>{
        const incomplete={...selection};delete (incomplete as Partial<IProjectEmbedding>)[field];
        expect(()=>requireProjectEmbedding(incomplete,'prj-one')).toThrow('неполный');
    });
    it('Модель другой размерности создаёт reindex intent и не пишет прямой PATCH выбора',async()=>{
        render();await settle();choice().onChange('wrong');render();button('Подключить модель проекта').onClick!();await settle();
        expect(base.post).toHaveBeenCalledWith('/api/projects/prj-one/embedding/reindex',expect.objectContaining({modelId:'wrong',expectedModelPin:model('wrong').modelPin,expectedSelectionRevision:2}));
        expect(base.patch).not.toHaveBeenCalled();
    });
});

describe('Явное подключение OpenCodeRAG к подтверждённой модели',()=>{
    it('Согласие прежнего владельца не отправляет запрос после смены сеанса до React commit',()=>{
        mode='action';consent();const oldAction=button('Индексировать проект').onClick!;
        ui.scope='owner-b';ui.epoch++;oldAction();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Без согласия нет задания, после согласия отправляется точный tuple и локальный queued ACK блокирует повтор',async()=>{
        mode='action';render();expect(button('Индексировать проект').disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
        consent();button('Индексировать проект').onClick!();button('Индексировать проект').onClick!();await settle();
        expect(bridgeApi.create).toHaveBeenCalledOnce();expect(vi.mocked(bridgeApi.create).mock.calls[0][0]).toEqual({...actionInput,requestKey:expect.any(String)});
        expect(button('Индексировать проект').disabled).toBe(true);
    });
    it('Задержанный HTTP ещё не означает потерянный ACK; предупреждение появляется после отказа запроса',async()=>{
        mode='action';const held=deferred<IBridgeJob>();vi.mocked(bridgeApi.create).mockReturnValueOnce(held.promise);
        consent();button('Индексировать проект').onClick!();expect(render()).not.toContain('Ответ на запуск индексации не получен');
        expect(button('Передаём задание…').disabled).toBe(true);expect(bridgeApi.create).toHaveBeenCalledOnce();
        held.reject(new Error('Ответ потерян'));await settle();expect(render()).toContain('Ответ на запуск индексации не получен');
        expect(button('Проверить отправленную индексацию').disabled).toBe(false);expect(bridgeApi.create).toHaveBeenCalledOnce();
    });
    it('Потерянный ACK не превращает найденное по имени завершённое задание в успех; retry использует прежний ключ',async()=>{
        mode='action';vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));consent();button('Индексировать проект').onClick!();await settle();
        current.bridge.jobs=[job({state:'succeeded',result:result()})];expect(render()).not.toContain('Индекс проекта готов');
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(current.bridge.jobs[0]);button('Проверить отправленную индексацию').onClick!();await settle();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(vi.mocked(bridgeApi.create).mock.calls[0][0]);
        expect(render()).toContain('Перезапустите OpenCode');expect(render()).toContain('Локальный индекс перестроен и синхронизирован с сервером');expect(render()).toContain('Серверная копия обновлена');
    });
    it('Чужая pending mutation и незавершённое подключение не дают создать новую операцию',()=>{
        mode='action';current.bridge.jobs=[job({kind:'bind-project'})];consent();expect(button('Индексировать проект').disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Успех с другим pin не выдаётся за подтверждённое подключение',async()=>{
        mode='action';vi.mocked(bridgeApi.create).mockResolvedValueOnce(job({state:'succeeded',result:{...result(),modelPin:'f'.repeat(64)}}));
        consent();button('Индексировать проект').onClick!();await settle();expect(render()).not.toContain('Индекс проекта готов');expect(render()).toContain('не подтверждено для текущей модели');
    });
    it.each(['missing','unsynced'])('Подключение без завершённого receipt переиндексации не становится успехом (%s)',async state=>{
        mode='action';const reindex=state==='missing'?undefined:{...result().reindex,serverSynced:false};
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(job({state:'succeeded',result:{...result(),reindex}}));
        consent();button('Индексировать проект').onClick!();await settle();
        expect(render()).not.toContain('Индекс проекта готов');expect(ui.prefer).not.toHaveBeenCalled();
    });
    it('Старому мосту и пакету даёт конкретный путь обновления, а исправная установка показывает полный контекст согласия',()=>{
        mode='connection';current.device.report.capabilities=current.device.report.capabilities!.filter(value=>value!=='hosted-rag-reindex-v1');
        render();expect(button('Обновить мост').href).toBe('/start');expect(bridgeApi.create).not.toHaveBeenCalled();
        current.device.report.capabilities.push('hosted-rag-reindex-v1');current.item.hostedEmbedding=undefined;render();expect(ui.buttons.has('Открыть OpenCodeRAG в каталоге')).toBe(true);
        current.item.hostedEmbedding={supported:true,reindexSupported:true};const html=render();expect(html).toContain('/fixture/root/Проект');expect(html).toContain('Рабочий компьютер');expect(ui.consent?.checked).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('При двух проверенных установках просит выбрать нужную и сохраняет отдельное согласие на подключение',()=>{
        mode='connection';const plugin={...current.item,assetId:'rag-plugin',assetKind:'plugin' as const,
            inspection:{...current.item.inspection!,assetId:'rag-plugin',assetKind:'plugin' as const}};
        current.bridge.installations=[current.item,plugin];const html=render(),installations=ui.choices.get('Установка OpenCodeRAG для модели')!;
        expect(installations.options).toHaveLength(2);expect(installations.value).toBeUndefined();
        expect(html).toContain('Выберите установку OpenCodeRAG для подключения модели.');expect(html).not.toContain('Установите или обновите');
        expect(ui.buttons.has('Открыть OpenCodeRAG в каталоге')).toBe(false);expect(ui.consent).toBeUndefined();expect(bridgeApi.create).not.toHaveBeenCalled();
        installations.onChange(installations.options[1].value);render();expect(ui.consent?.checked).toBe(false);
        expect(button('Индексировать проект').disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Мост без immutable grants не разрешает подключение, обновление снимает блокировку',()=>{
        mode='connection';current.device.report.capabilities=current.device.report.capabilities!.filter(value=>value!=='hosted-rag-grants-v1');current.bridge.installations=[current.item,checkedPlugin()];
        const html=render(),installations=ui.choices.get('Установка OpenCodeRAG для модели')!;
        expect(html).toContain('Для совместной работы MCP и плагина обновите мост и оба пакета OpenCodeRAG из каталога.');
        expect(button('Обновить мост').href).toBe('/start');expect(bridgeApi.create).not.toHaveBeenCalled();
        installations.onChange(installations.options[0].value);consent();expect(button('Индексировать проект').disabled).toBe(true);
        current.device.report.capabilities!.push('hosted-rag-grants-v1');
        expect(render()).not.toContain('Для совместной работы MCP и плагина обновите мост');
        expect(ui.buttons.has('Обновить мост')).toBe(false);expect(button('Индексировать проект').disabled).toBe(false);
        expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Появление второй установки не снимает прежний выбор и не теряет ключ подключения после потерянного ответа',async()=>{
        mode='connection';vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));consent();button('Индексировать проект').onClick!();await settle();
        const original=vi.mocked(bridgeApi.create).mock.calls[0][0];current.bridge.installations=[current.item,checkedPlugin()];render();
        const installations=ui.choices.get('Установка OpenCodeRAG для модели')!;expect(installations.value).toBe(installations.options[0].value);
        expect(button('Проверить отправленную индексацию').disabled).toBe(false);expect(bridgeApi.create).toHaveBeenCalledOnce();
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(job({state:'succeeded',result:result()}));button('Проверить отправленную индексацию').onClick!();await settle();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(original);expect(render()).toContain('Индекс проекта готов');
    });
    it('Утрата выбранной установки не подставляет другой пакет и сохраняет безопасный повтор после её возврата',async()=>{
        mode='connection';const plugin=checkedPlugin();current.bridge.installations=[current.item,plugin];render();
        const installations=ui.choices.get('Установка OpenCodeRAG для модели')!;const originalChoice=installations.options[0].value;installations.onChange(originalChoice);
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));consent();button('Индексировать проект').onClick!();await settle();
        const original=vi.mocked(bridgeApi.create).mock.calls[0][0];current.bridge.installations=[plugin];render();
        expect(ui.choices.get('Установка OpenCodeRAG для модели')?.value).toBe(originalChoice);expect(button('Проверить отправленную индексацию').disabled).toBe(true);expect(bridgeApi.create).toHaveBeenCalledOnce();
        expect(ui.choices.get('Установка OpenCodeRAG для модели')?.options[0]).toMatchObject({value:originalChoice,disabled:true});
        current.bridge.installations=[current.item,plugin];render();expect(button('Проверить отправленную индексацию').disabled).toBe(false);
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(job());button('Проверить отправленную индексацию').onClick!();await settle();expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(original);
    });
    it('Смена компьютера или владельца не возвращает прежний выбор установки при переходе туда и обратно',()=>{
        mode='connection';const plugin=checkedPlugin();current.bridge.installations=[current.item,plugin];render();
        const choose=()=>ui.choices.get('Установка OpenCodeRAG для модели')!;choose().onChange(choose().options[1].value);render();expect(ui.consent).toBeDefined();
        const originalDevice=current.bridge.device,originalItems=current.bridge.installations;
        current.bridge.device={...current.device,id:'device-two'};current.bridge.installations=originalItems.map(item=>({...item,deviceId:'device-two'}));render();expect(choose().value).toBeUndefined();expect(ui.consent).toBeUndefined();
        current.bridge.device=originalDevice;current.bridge.installations=originalItems;render();expect(choose().value).toBeUndefined();
        choose().onChange(choose().options[1].value);render();ui.scope='owner-b';render();expect(choose().value).toBeUndefined();ui.scope='owner-a';render();expect(choose().value).toBeUndefined();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('После проверенного успеха показывает результат в Нейроцентре и новый запуск требует свежего согласия и ключа',async()=>{
        mode='action';vi.mocked(bridgeApi.create).mockResolvedValueOnce(job({state:'succeeded',result:result()}));
        consent();button('Индексировать проект').onClick!();await settle();
        expect(render()).toContain('Индекс проекта готов');expect(render()).toContain('Серверная копия обновлена');
        expect(render()).toContain('id="project-index-actions"');expect(button('Серверная база знаний').href).toBe('/projects/prj-one?tab=rag');
        expect(ui.prefer).not.toHaveBeenCalled();expect(ui.buttons.has('Перейти к интерфейсу установки')).toBe(false);
        expect(ui.consent?.checked).toBe(false);expect(button('Обновить индекс').disabled).toBe(true);
        button('Обновить индекс').onClick!();expect(bridgeApi.create).toHaveBeenCalledOnce();
        consent();const repeat=button('Обновить индекс');repeat.onClick!();repeat.onClick!();await settle();
        const [first,second]=vi.mocked(bridgeApi.create).mock.calls.map(([input])=>input);
        expect(bridgeApi.create).toHaveBeenCalledTimes(2);expect(first).toMatchObject(actionInput);expect(second).toMatchObject(actionInput);
        expect(second.requestKey).not.toBe(first.requestKey);expect(ui.consent?.checked).toBe(false);
        expect(button('Обновить индекс').disabled).toBe(true);
    });
    it('Исторический успех той же цели разрешает явное обновление без перехода в отдельный интерфейс',()=>{
        mode='action';current.bridge.jobs=[job({state:'succeeded',result:result()})];
        expect(render()).toContain('Индекс проекта готов');expect(button('Обновить индекс').disabled).toBe(true);
        consent();expect(button('Обновить индекс').disabled).toBe(false);expect(ui.prefer).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Потерянный ACK повторного запуска скрывает прошлый успех и проверяется тем же ключом при видимом pending',async()=>{
        mode='action';current.bridge.jobs=[job({state:'succeeded',result:result()})];
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));
        consent();button('Обновить индекс').onClick!();await settle();
        const sent=vi.mocked(bridgeApi.create).mock.calls[0][0];
        const accepted=job({id:'repeat-job',state:'running',percent:42,message:'Индексируем файлы'});
        current.bridge.jobs=[accepted,...current.bridge.jobs];expect(render()).not.toContain('Индекс проекта готов');
        expect(ui.consent?.checked).toBe(false);expect(button('Проверить отправленную индексацию').disabled).toBe(false);
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(accepted);button('Проверить отправленную индексацию').onClick!();await settle();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(sent);
        expect(render()).toContain('Индексируем файлы');expect(render()).toContain('<progress value="42"');
        expect(button('Обновить индекс').disabled).toBe(true);expect(ui.prefer).not.toHaveBeenCalled();
    });
    it.each(['queued','running','reconciling'])('Точное активное задание %s показывает ход и блокирует новый запуск вместо старого успеха',state=>{
        mode='action';current.bridge.jobs=[job({id:'done',state:'succeeded',result:result()}),job({id:'active',state,percent:37,message:'Проверяем индекс'})];
        const html=render();expect(html).not.toContain('Индекс проекта готов');expect(html).toContain('Проверяем индекс');expect(html).toContain('<progress value="37"');
        expect(button('Ход операции').href).toBe('/operations');expect(button('Обновить индекс').disabled).toBe(true);
        expect(ui.buttons.has('Отменить индексацию')).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Смена точной цели сбрасывает согласие и не возвращает его при переходе обратно',()=>{
        mode='action';consent();const oldAction=button('Индексировать проект').onClick!,original=actionInput;
        actionInput={...original,assetId:'rag-plugin',assetKind:'plugin'};render();oldAction();expect(bridgeApi.create).not.toHaveBeenCalled();
        expect(ui.consent?.checked).toBe(false);consent();actionInput=original;render();expect(ui.consent?.checked).toBe(false);
        button('Индексировать проект').onClick!();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Отсутствующая общая папка и неподтверждённый instance не допускают запуск и не ломают форму',()=>{
        mode='connection';current.device.report.root=undefined;render();expect(button('Выбрать общую папку').href).toBe('/projects');
        expect(button('Индексировать проект').disabled).toBe(true);
        current.device.report.root='/fixture/root';current.binding.instanceId='invalid';render();expect(button('Связать папку').href).toBe('/projects?bind=prj-one');
        expect(ui.buttons.has('Индексировать проект')).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
});
