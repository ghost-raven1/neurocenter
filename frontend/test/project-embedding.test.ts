import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import base from '../src/core/api/base';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
import type {ICatalogModel,IModelCatalog} from '../src/features/ModelCatalog/types';
import {ProjectEmbedding,ProjectEmbeddingContent} from '../src/features/ProjectEmbedding/ProjectEmbedding';
import {ProjectEmbeddingConnection,ConnectEmbeddingAction} from '../src/features/ProjectEmbedding/ProjectEmbeddingConnection';
import {embeddingConnectionInput} from '../src/features/ProjectEmbedding/connection';
import {requireProjectEmbedding,type IProjectEmbedding} from '../src/features/ProjectEmbedding/model';
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
    owners:new Map<string,()=>()=>boolean>(),
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,useEffect:hooks.useEffect}));
vi.mock('react-redux',()=>({useSelector:()=>({email:'admin@example.test',activeRole:'Главный админ',userRoles:['Главный админ']})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    const scope=ui.scope,epoch=ui.epoch,key=JSON.stringify([scope,epoch]);
    if(!ui.owners.has(key))ui.owners.set(key,()=>()=>scope===ui.scope&&epoch===ui.epoch);
    return{scope,captureOwner:ui.owners.get(key)!};
}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),patch:vi.fn()}}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{list:vi.fn()}}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{create:vi.fn()}}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>ui.bridge}));
vi.mock('../src/features/McpBridge/ragUi/OpenCodeRagUi',()=>({OpenCodeRagUi:(props:NonNullable<typeof ui.ragUi>)=>{ui.ragUi=props;return 'Управление индексом выбранной установки';}}));
vi.mock('antd',async()=>{
    const{createElement:h}=await import('react');const content=({children}:{children?:ReactNode})=>children;
    return{Space:content,Card:({title,extra,children}:{title:ReactNode;extra:ReactNode;children:ReactNode})=>h('div',null,title,extra,children),
        Spin:()=>null,Progress:()=>null,Typography:{Paragraph:content,Text:content},
        Alert:({message,description,action}:{message:ReactNode;description?:ReactNode;action?:ReactNode})=>h('div',null,message,description,action),
        Button:(props:Button)=>{if(typeof props.children==='string')ui.buttons.set(props.children,props);return h('button',{disabled:props.disabled},props.children);},
        Select:(props:Choice&{'aria-label':string})=>{ui.choices.set(props['aria-label'],props);return null;},
        Checkbox:(props:Consent&{children:ReactNode})=>{ui.consent=props;return props.children;},
    };
});
const model=(id:string,changes:Partial<ICatalogModel>={}):ICatalogModel=>({id,name:'Модель '+id,description:'',capability:'embedding',runtime:'ollama',model:'qwen3-embedding:4b',
    manifestSha256:'c'.repeat(64),dimension:2560,source:'builtin',revision:1,createdAt:'2026-10-20',updatedAt:'2026-10-20',...changes});
let selection:IProjectEmbedding,catalog:IModelCatalog,current:ReturnType<typeof ragUiFixture>,mode:'panel'|'action'|'connection',canManage:boolean,canConnect:boolean;
let actionInput:ReturnType<typeof embeddingConnectionInput>;
function render(){hooks.begin();ui.buttons.clear();ui.choices.clear();ui.consent=undefined;ui.ragUi=undefined;
    const component=mode==='panel'?createElement(ProjectEmbeddingContent,{projectId:'prj-one',serverHasData:true,indexProfile:{provider:'ollama',model:'legacy:tag',dimension:2560},canManage,canConnect})
        :mode==='connection'?createElement(ProjectEmbeddingConnection,{selection,disabled:false})
        :createElement(ConnectEmbeddingAction,{input:actionInput,selection,bridge:current.bridge,disabled:false,consent:'Модель А · компьютер А · /fixture/root/Проект'});
    const html=renderToStaticMarkup(component);hooks.commit();return html;
}
async function settle(){for(let i=0;i<12;i++)await Promise.resolve();render();render();}
function button(label:string){const item=ui.buttons.get(label);expect(item,`кнопка ${label}`).toBeDefined();return item!;}
const choice=()=>ui.choices.get('Модель эмбеддингов проекта')!;
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const result=()=>({status:'connected',revision:selection.revision,modelPin:selection.modelPin,profile:selection.profile,requiresRestart:true});
function job(changes:Partial<IBridgeJob>={}):IBridgeJob{return current.job({kind:'connect-rag-model',...changes});}
function checkedPlugin(){return{...current.item,assetId:'rag-plugin',assetKind:'plugin' as const,
    inspection:{...current.item.inspection!,assetId:'rag-plugin',assetKind:'plugin' as const}};}
function consent(){render();expect(ui.consent?.checked).toBe(false);ui.consent!.onChange({target:{checked:true}});render();}
beforeEach(()=>{
    vi.clearAllMocks();mode='panel';canManage=true;canConnect=false;ui.scope='owner-a';ui.epoch=0;ui.owners.clear();
    current=ragUiFixture();ui.bridge=current.bridge;current.device.report.root='/fixture/root';current.device.report.capabilities!.push('hosted-rag-model-v1');
    current.item.hostedEmbedding={supported:true};current.item.inspection={schemaVersion:1,projectId:current.item.projectId,bindingId:current.binding.bindingId,assetId:current.item.assetId,
        assetKind:current.item.assetKind,version:current.item.version,manifest:current.item.manifest,checkedAt:'2026-10-20T01:00:00Z',readiness:'unverified',state:'checked',status:'synced',issues:[]};
    selection={projectId:'prj-one',revision:2,expectedDimension:2560,model:model('a'),modelPin:'d'.repeat(64),profile:{provider:'openai',model:'nc-'+'d'.repeat(64),dimension:2560}};
    catalog={items:[model('a'),model('b'),model('wrong',{dimension:384}),model('chat',{capability:'chat'}),model('unassigned'),model('unsealed',{manifestSha256:null})],assignedModelIds:['a','b','wrong','chat','unsealed']};
    vi.mocked(base.get).mockImplementation(async()=>({data:selection}));vi.mocked(base.patch).mockImplementation(async(_url,body)=>({data:{...selection,revision:3,model:model((body as {modelId:string}).modelId)}}));
    vi.mocked(modelCatalogApi.list).mockResolvedValue(catalog);vi.mocked(bridgeApi.create).mockResolvedValue(job());
    actionInput=embeddingConnectionInput(current.item,current.binding,selection);
});
afterEach(()=>hooks.dispose());

describe('Выбор embedding-модели проекта без скрытых операций',()=>{
    it('Загружает выбор, показывает только назначенные совместимые модели и ничего не запускает',async()=>{
        render();await settle();expect(choice().options.map(value=>value.value)).toEqual(['a','b']);expect(choice().value).toBe('a');
        expect(base.patch).not.toHaveBeenCalled();expect(bridgeApi.create).not.toHaveBeenCalled();expect(button('Открыть модели в каталоге проекта').href).toBe('/projects/prj-one?tab=store&catalogTab=models');
    });
    it('Черновик сохраняется только явной кнопкой с ожидаемой ревизией, двойной клик не повторяет PATCH',async()=>{
        render();await settle();choice().onChange('b');render();expect(base.patch).not.toHaveBeenCalled();
        const pending=deferred<{data:IProjectEmbedding}>();vi.mocked(base.patch).mockReturnValueOnce(pending.promise);
        const save=button('Сохранить модель проекта');save.onClick!();save.onClick!();expect(base.patch).toHaveBeenCalledOnce();
        expect(base.patch).toHaveBeenCalledWith('/api/projects/prj-one/embedding',{expectedRevision:2,modelId:'b'});
        pending.resolve({data:{...selection,revision:3,model:model('b')}});await settle();expect(choice().value).toBe('b');expect(button('Сохранить модель проекта').disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Конфликт не стирает черновик; после чтения нового выбора следующий явный save использует новую ревизию',async()=>{
        render();await settle();choice().onChange('b');render();vi.mocked(base.patch).mockRejectedValueOnce(new Error('Выбор уже изменён'));
        button('Сохранить модель проекта').onClick!();await settle();expect(choice().value).toBe('b');expect(render()).toContain('Выбор уже изменён');
        selection={...selection,revision:7};button('Обновить сведения').onClick!();await settle();expect(choice().value).toBe('b');
        button('Сохранить модель проекта').onClick!();await settle();expect(vi.mocked(base.patch).mock.calls[1][1]).toEqual({expectedRevision:7,modelId:'b'});
    });
    it('Изменившийся pin той же модели можно закрепить заново без выбора другой модели',async()=>{
        selection={...selection,blocker:'Закреплённая модель изменилась. Выберите её заново.'};render();await settle();
        expect(button('Сохранить модель проекта').disabled).toBe(false);button('Сохранить модель проекта').onClick!();await settle();
        expect(base.patch).toHaveBeenCalledWith('/api/projects/prj-one/embedding',{expectedRevision:2,modelId:'a'});
    });
    it('Удалённая модель со старым pin и профилем показывается с причиной и допускает очистку выбора',async()=>{
        selection={...selection,model:null,blocker:'Выбранная модель удалена из каталога.'};render();await settle();
        expect(render()).toContain('Выбранная модель удалена из каталога');expect(button('Сохранить модель проекта').disabled).toBe(false);
        button('Сохранить модель проекта').onClick!();await settle();expect(base.patch).toHaveBeenCalledWith('/api/projects/prj-one/embedding',{expectedRevision:2,modelId:null});
    });
    it('Наблюдатель читает модель и несовместимый серверный профиль, но не видит управление',async()=>{
        canManage=false;render();await settle();const html=render();expect(ui.choices.size).toBe(0);expect(ui.buttons.has('Сохранить модель проекта')).toBe(false);
        expect(html).toContain('Модель a');expect(html).toContain('ollama · legacy:tag · 2560');expect(html).toContain('Текущая серверная копия сохранена');expect(html).toContain('нового проекта');expect(base.patch).not.toHaveBeenCalled();
    });
    it('Сбой чтения можно повторить в той же форме без запуска моста',async()=>{
        vi.mocked(base.get).mockRejectedValueOnce(new Error('Сервис недоступен'));render();await settle();expect(render()).toContain('Сервис недоступен');
        button('Повторить загрузку').onClick!();await settle();expect(choice().value).toBe('a');expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Сбой каталога не скрывает свежую сохранённую модель и её подключение, но блокирует изменение выбора',async()=>{
        canConnect=true;vi.mocked(modelCatalogApi.list).mockRejectedValueOnce(new Error('Каталог временно недоступен'));
        render();await settle();expect(render()).toContain('Сохранённая модель');expect(render()).toContain('Модель a');expect(render()).toContain('Каталог временно недоступен');
        expect(render()).not.toContain('Выбранная модель больше не доступна');expect(choice().disabled).toBe(true);expect(button('Сохранить модель проекта').disabled).toBe(true);
        button('Сохранить модель проекта').onClick!();expect(base.patch).not.toHaveBeenCalled();consent();expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(false);
        expect(bridgeApi.create).not.toHaveBeenCalled();button('Обновить сведения').onClick!();await settle();expect(choice().disabled).toBe(false);
    });
    it('Ошибка авторитетного выбора блокирует подключение даже при доступном каталоге',async()=>{
        canConnect=true;render();await settle();consent();vi.mocked(base.get).mockRejectedValueOnce(new Error('Доступ запрещён'));
        button('Обновить сведения').onClick!();await settle();expect(render()).toContain('Доступ запрещён');expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(true);
        button('Подключить модель к OpenCodeRAG').onClick!();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it.each([401,403,404])('Отказ доступа к каталогу %s не разрешает подключение по предыдущим сведениям',async status=>{
        canConnect=true;vi.mocked(modelCatalogApi.list).mockRejectedValueOnce(Object.assign(new Error('Доступ закрыт'),{isAxiosError:true,response:{status}}));
        render();await settle();consent();expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(true);button('Подключить модель к OpenCodeRAG').onClick!();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Медленный каталог не задерживает чтение модели, а поздний ответ прежнего владельца не меняет новый каталог',async()=>{
        canConnect=true;const old=deferred<IModelCatalog>();vi.mocked(modelCatalogApi.list).mockReturnValueOnce(old.promise);
        render();await settle();expect(render()).toContain('Модель a');expect(choice().disabled).toBe(true);consent();expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(false);
        hooks.dispose();ui.scope='owner-b';selection={...selection,model:model('b')};render();await settle();
        old.resolve({items:[],assignedModelIds:[]});await settle();expect(choice().value).toBe('b');expect(choice().options.map(item=>item.value)).toEqual(['a','b']);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Поздний GET закрытой формы и save прежнего владельца не подменяют новый выбор',async()=>{
        const old=deferred<{data:IProjectEmbedding}>();vi.mocked(base.get).mockReturnValueOnce(old.promise);render();hooks.dispose();
        selection={...selection,revision:8,model:model('b')};render();await settle();old.resolve({data:{...selection,revision:1,model:model('a')}});await settle();expect(choice().value).toBe('b');
        const save=deferred<{data:IProjectEmbedding}>();vi.mocked(base.patch).mockReturnValueOnce(save.promise);choice().onChange('a');render();button('Сохранить модель проекта').onClick!();
        ui.epoch++;hooks.dispose();render();await settle();save.resolve({data:{...selection,revision:9,model:model('a')}});await settle();expect(choice().value).toBe('b');
    });
    it('Ключ формы меняется вместе с проектом и владельцем, технически неполный DTO отклоняется',()=>{
        const first=ProjectEmbedding({projectId:'prj-one',serverHasData:false}).key;ui.scope='owner-b';
        expect(ProjectEmbedding({projectId:'prj-one',serverHasData:false}).key).not.toBe(first);
        expect(ProjectEmbedding({projectId:'prj-two',serverHasData:false}).key).not.toBe(first);
        expect(()=>requireProjectEmbedding({...selection,profile:{...selection.profile!,dimension:384}},'prj-one')).toThrow('неполный');
    });
});

describe('Явное подключение OpenCodeRAG к подтверждённой модели',()=>{
    it('Согласие прежнего владельца не отправляет запрос после смены сеанса до React commit',()=>{
        mode='action';consent();const oldAction=button('Подключить модель к OpenCodeRAG').onClick!;
        ui.scope='owner-b';ui.epoch++;oldAction();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Без согласия нет задания, после согласия отправляется точный tuple и локальный queued ACK блокирует повтор',async()=>{
        mode='action';render();expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
        consent();button('Подключить модель к OpenCodeRAG').onClick!();button('Подключить модель к OpenCodeRAG').onClick!();await settle();
        expect(bridgeApi.create).toHaveBeenCalledOnce();expect(vi.mocked(bridgeApi.create).mock.calls[0][0]).toEqual({...actionInput,requestKey:expect.any(String)});
        expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(true);
    });
    it('Потерянный ACK не превращает найденное по имени завершённое задание в успех; retry использует прежний ключ',async()=>{
        mode='action';vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));consent();button('Подключить модель к OpenCodeRAG').onClick!();await settle();
        current.bridge.jobs=[job({state:'succeeded',result:result()})];expect(render()).not.toContain('Подключение модели проверено');
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(current.bridge.jobs[0]);button('Проверить отправленное подключение').onClick!();await settle();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(vi.mocked(bridgeApi.create).mock.calls[0][0]);
        expect(render()).toContain('Перезапустите OpenCode');expect(render()).toContain('Индекс не изменён');expect(render()).toContain('Для серверной модели автоматическая индексация отключена');
    });
    it('Чужая pending mutation и незавершённое подключение не дают создать новую операцию',()=>{
        mode='action';current.bridge.jobs=[job({kind:'bind-project'})];consent();expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Успех с другим pin не выдаётся за подтверждённое подключение',async()=>{
        mode='action';vi.mocked(bridgeApi.create).mockResolvedValueOnce(job({state:'succeeded',result:{...result(),modelPin:'f'.repeat(64)}}));
        consent();button('Подключить модель к OpenCodeRAG').onClick!();await settle();expect(render()).not.toContain('Подключение модели проверено');expect(render()).toContain('не подтверждено для текущей модели');
    });
    it('Старому мосту и пакету даёт конкретный путь обновления, а исправная установка показывает полный контекст согласия',()=>{
        mode='connection';current.device.report.capabilities=current.device.report.capabilities!.filter(value=>value!=='hosted-rag-model-v1');
        render();expect(button('Обновить мост').href).toBe('/start');expect(bridgeApi.create).not.toHaveBeenCalled();
        current.device.report.capabilities.push('hosted-rag-model-v1');current.item.hostedEmbedding=undefined;render();expect(ui.buttons.has('Открыть OpenCodeRAG в каталоге')).toBe(true);
        current.item.hostedEmbedding={supported:true};const html=render();expect(html).toContain('/fixture/root/Проект');expect(html).toContain('Рабочий компьютер');expect(ui.consent?.checked).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('При двух проверенных установках просит выбрать нужную и сохраняет отдельное согласие на подключение',()=>{
        mode='connection';const plugin={...current.item,assetId:'rag-plugin',assetKind:'plugin' as const,
            inspection:{...current.item.inspection!,assetId:'rag-plugin',assetKind:'plugin' as const}};
        current.bridge.installations=[current.item,plugin];const html=render(),installations=ui.choices.get('Установка OpenCodeRAG для модели')!;
        expect(installations.options).toHaveLength(2);expect(installations.value).toBeUndefined();
        expect(html).toContain('Выберите установку OpenCodeRAG для подключения модели.');expect(html).not.toContain('Установите или обновите');
        expect(ui.buttons.has('Открыть OpenCodeRAG в каталоге')).toBe(false);expect(ui.consent).toBeUndefined();expect(bridgeApi.create).not.toHaveBeenCalled();
        installations.onChange(installations.options[1].value);render();expect(ui.consent?.checked).toBe(false);
        expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Старому мосту с двумя установками объясняет обновление для совместной работы, сохраняя явное одиночное подключение',()=>{
        mode='connection';current.bridge.installations=[current.item,checkedPlugin()];
        const html=render(),installations=ui.choices.get('Установка OpenCodeRAG для модели')!;
        expect(html).toContain('Для совместной работы MCP и плагина обновите мост и оба пакета OpenCodeRAG из каталога.');
        expect(button('Обновить мост').href).toBe('/start');expect(bridgeApi.create).not.toHaveBeenCalled();
        installations.onChange(installations.options[0].value);consent();expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(false);
        current.device.report.capabilities!.push('hosted-rag-grants-v1');
        expect(render()).not.toContain('Для совместной работы MCP и плагина обновите мост');
        expect(ui.buttons.has('Обновить мост')).toBe(false);expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(false);
        expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Появление второй установки не снимает прежний выбор и не теряет ключ подключения после потерянного ответа',async()=>{
        mode='connection';vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));consent();button('Подключить модель к OpenCodeRAG').onClick!();await settle();
        const original=vi.mocked(bridgeApi.create).mock.calls[0][0];current.bridge.installations=[current.item,checkedPlugin()];render();
        const installations=ui.choices.get('Установка OpenCodeRAG для модели')!;expect(installations.value).toBe(installations.options[0].value);
        expect(button('Проверить отправленное подключение').disabled).toBe(false);expect(bridgeApi.create).toHaveBeenCalledOnce();
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(job({state:'succeeded',result:result()}));button('Проверить отправленное подключение').onClick!();await settle();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(original);expect(render()).toContain('Подключение модели проверено');
    });
    it('Утрата выбранной установки не подставляет другой пакет и сохраняет безопасный повтор после её возврата',async()=>{
        mode='connection';const plugin=checkedPlugin();current.bridge.installations=[current.item,plugin];render();
        const installations=ui.choices.get('Установка OpenCodeRAG для модели')!;const originalChoice=installations.options[0].value;installations.onChange(originalChoice);
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));consent();button('Подключить модель к OpenCodeRAG').onClick!();await settle();
        const original=vi.mocked(bridgeApi.create).mock.calls[0][0];current.bridge.installations=[plugin];render();
        expect(ui.choices.get('Установка OpenCodeRAG для модели')?.value).toBe(originalChoice);expect(button('Проверить отправленное подключение').disabled).toBe(true);expect(bridgeApi.create).toHaveBeenCalledOnce();
        expect(ui.choices.get('Установка OpenCodeRAG для модели')?.options[0]).toMatchObject({value:originalChoice,disabled:true});
        current.bridge.installations=[current.item,plugin];render();expect(button('Проверить отправленное подключение').disabled).toBe(false);
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(job());button('Проверить отправленное подключение').onClick!();await settle();expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(original);
    });
    it('Смена компьютера или владельца не возвращает прежний выбор установки при переходе туда и обратно',()=>{
        mode='connection';const plugin=checkedPlugin();current.bridge.installations=[current.item,plugin];render();
        const choose=()=>ui.choices.get('Установка OpenCodeRAG для модели')!;choose().onChange(choose().options[1].value);render();expect(ui.consent).toBeDefined();
        const originalDevice=current.bridge.device,originalItems=current.bridge.installations;
        current.bridge.device={...current.device,id:'device-two'};current.bridge.installations=originalItems.map(item=>({...item,deviceId:'device-two'}));render();expect(choose().value).toBeUndefined();expect(ui.consent).toBeUndefined();
        current.bridge.device=originalDevice;current.bridge.installations=originalItems;render();expect(choose().value).toBeUndefined();
        choose().onChange(choose().options[1].value);render();ui.scope='owner-b';render();expect(choose().value).toBeUndefined();ui.scope='owner-a';render();expect(choose().value).toBeUndefined();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('После подключения предлагает управление индексом той же установки без автоматического открытия или индексирования',async()=>{
        mode='action';current.bridge.installations=[current.item,checkedPlugin()];vi.mocked(bridgeApi.create).mockResolvedValueOnce(job({state:'succeeded',result:result()}));
        consent();button('Подключить модель к OpenCodeRAG').onClick!();await settle();expect(render()).toContain('Управление индексом выбранной установки');
        expect(ui.ragUi?.bridge.installations).toEqual([current.item]);expect(ui.ragUi?.projectId).toBe(selection.projectId);expect(ui.ragUi?.canWrite).toBe(true);
        expect(bridgeApi.create).toHaveBeenCalledOnce();expect(vi.mocked(bridgeApi.create).mock.calls[0][0].kind).toBe('connect-rag-model');
    });
    it('Отсутствующая общая папка и неподтверждённый instance не допускают запуск и не ломают форму',()=>{
        mode='connection';current.device.report.root=undefined;render();expect(button('Выбрать общую папку').href).toBe('/projects');
        expect(button('Подключить модель к OpenCodeRAG').disabled).toBe(true);
        current.device.report.root='/fixture/root';current.binding.instanceId='invalid';render();expect(button('Связать папку').href).toBe('/projects?bind=prj-one');
        expect(ui.buttons.has('Подключить модель к OpenCodeRAG')).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
});
