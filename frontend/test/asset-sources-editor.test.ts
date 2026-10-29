import './feature-flags-enabled';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AssetSources from '../src/features/AssetSources/AssetSources';
import { agentCatalogApi } from '../src/features/AgentCatalog/api';
import { baseApi } from '../src/core/api';
import { agent } from './agent-fixtures';
import type { ICatalogAgent } from '../src/features/AgentCatalog/types';
import type { IAssetImport } from '../src/features/AssetSources/types';
import type {AssetArchiveModal} from '../src/features/AssetSources/AssetArchiveModal';
type ArchiveModalProps=Parameters<typeof AssetArchiveModal>[0];

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return[slot.value,(next:unknown)=>{slot.value=typeof next==='function'?next(slot.value):next;}];},
        useRef:(initial:unknown)=>(slots[cursor++]??={value:{current:initial}}).value,
        useCallback:(value:unknown,deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return previous.value;slots[index]={value,deps};return value;},
        useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const ui=vi.hoisted(()=>({owner:'admin-a',owners:new Map<string,()=>()=>boolean>(),buttons:[] as Array<{disabled?:boolean;onClick:()=>void}>,editor:undefined as {agent:ICatalogAgent;onClose:()=>void;onSaved:()=>Promise<void>}|undefined,draft:'',editorId:'',searches:new Map<string,{onChange:(event:{target:{value:string}})=>void}>(),archives:[]as Array<{kind:string;id:string;restore?:boolean;disabled?:boolean}>,live:()=>{},refreshButtons:new Map<string,{loading?:boolean;onClick:()=>void}>(),job:undefined as IAssetImport|undefined,retry:vi.fn(),retryButton:undefined as undefined|(()=>void)}));
const archiveUi=vi.hoisted(()=>({modal:undefined as ArchiveModalProps|undefined,buttons:[]as Array<{label:string;disabled?:boolean;onClick:()=>void}>,checkboxes:[]as Array<{'aria-label':string;disabled?:boolean;checked?:boolean;onChange:(event:{target:{checked:boolean}})=>void}>,blocked:false,start:vi.fn(),emptyDescription:''}));
const bundledUi=vi.hoisted(()=>({props:undefined as {plans:unknown[];scope:string}|undefined}));
vi.mock('../src/features/AssetSources/BundledCatalogSources',()=>({BundledCatalogSources:(props:{plans:unknown[];scope:string})=>{bundledUi.props=props;return null;}}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),...hooks}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const scope=ui.owner;let captureOwner=ui.owners.get(scope);if(!captureOwner){captureOwner=()=>()=>scope===ui.owner;ui.owners.set(scope,captureOwner);}return{scope,captureOwner};}}));
vi.mock('../src/core/api',()=>({baseApi:{get:vi.fn(),post:vi.fn(),put:vi.fn()},bffApi:{getSkill:vi.fn(),getAiPlugin:vi.fn()}}));
vi.mock('../src/features/AgentCatalog/api',()=>({agentCatalogApi:{get:vi.fn()}}));
vi.mock('../src/features/AssetSources/useAssetImports',()=>({useAssetImports:()=>({blocked:archiveUi.blocked,busy:false,job:ui.job,retry:ui.retry,start:archiveUi.start})}));
vi.mock('../src/features/AssetSources/AssetArchiveModal',()=>({AssetArchiveModal:(props:ArchiveModalProps)=>{archiveUi.modal=props;return null;}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(_sections:string[],refresh:()=>void)=>{ui.live=refresh;}}));
vi.mock('../src/features/AssetManagement/ArchiveAssetButton',()=>({ArchiveAssetButton:(props:typeof ui.archives[number])=>{ui.archives.push(props);return null;}}));
vi.mock('../src/features/Catalog/StoreEditModal',()=>({default:()=>null}));
vi.mock('../src/features/ModelCatalog/ModelEditModal',()=>({ModelEditModal:()=>null}));
vi.mock('../src/features/Catalog/catalogCards',()=>({fromPlugin:vi.fn(),fromSkill:vi.fn()}));
vi.mock('../src/features/AgentCatalog/AgentEditModal',()=>({AgentEditModal:(props:NonNullable<typeof ui.editor>)=>{if(ui.editorId!==props.agent.id){ui.editorId=props.agent.id;ui.draft='';}ui.editor=props;return createElement('div',null,props.agent.name,ui.draft);}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;const input=()=>null;
    return{Card:({children,title}:{children?:ReactNode;title?:ReactNode})=>createElement('div',null,title,children),Space:content,Tag:content,Typography:{Title:content,Text:content,Paragraph:content},Checkbox:(props:typeof archiveUi.checkboxes[number])=>{archiveUi.checkboxes.push(props);return null;},
        Input:Object.assign(input,{Search:(props:{'aria-label':string;onChange:(event:{target:{value:string}})=>void})=>{ui.searches.set(props['aria-label'],props);return null;}}),List:()=>null,Spin:()=>null,Empty:({description}:{description:string})=>{archiveUi.emptyDescription=description;return null;},Modal:()=>null,
        Alert:({message,description}:{message:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),Button:({children,disabled,loading,onClick}:{children?:ReactNode;disabled?:boolean;loading?:boolean;onClick:()=>void})=>{if(children==='Редактировать')ui.buttons.push({disabled,onClick});if(typeof children==='string')archiveUi.buttons.push({label:children,disabled,onClick});if(typeof children==='string'&&(children.startsWith('Обновить ')||children==='Перечитать поставку'))ui.refreshButtons.set(children,{loading,onClick});if(children==='Проверить конфликт заново'||children==='Повторить после исправления')ui.retryButton=onClick;return children;}};
});
const source={source:{verified:true,commit:'a'.repeat(40)},assets:['a','b'].map(id=>({id:'source-'+id,kind:'agent',name:'Агент '+id,version:'1',license:'MIT',dependencies:[],imported:{id:'agent-'+id,originVersion:'1',version:1,updateAvailable:false}}))};
function render(){hooks.begin();ui.buttons=[];ui.archives=[];archiveUi.buttons=[];archiveUi.checkboxes=[];const html=renderToStaticMarkup(createElement(AssetSources));hooks.commit();return html;}
async function settle(){for(let n=0;n<15;n++)await Promise.resolve();return render();}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(cause:Error)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
beforeEach(()=>{vi.clearAllMocks();ui.owner='admin-a';ui.owners.clear();ui.refreshButtons.clear();ui.searches.clear();ui.editor=undefined;ui.draft='';ui.editorId='';ui.job=undefined;ui.retryButton=undefined;archiveUi.modal=undefined;archiveUi.blocked=false;vi.mocked(baseApi.get).mockResolvedValue({data:source});});
afterEach(()=>hooks.dispose());

it('Current source read failure keeps the scoped bundled build recovery mounted with no actionable recipes',async()=>{
    vi.mocked(baseApi.get).mockRejectedValueOnce(Error('Source unavailable'));render();const html=await settle();
    expect(html).toContain('Source unavailable');expect(bundledUi.props).toEqual({plans:[],scope:'admin-a',blocked:false,onPublished:expect.any(Function),onImportArchive:expect.any(Function)});
});

it('Двойной клик и открытие второй карточки во время GET не создают конкурирующий редактор',async()=>{
    const first=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValue(first.promise);render();await settle();const[openA,openB]=ui.buttons;
    openA.onClick();openA.onClick();openB.onClick();expect(agentCatalogApi.get).toHaveBeenCalledExactlyOnceWith('agent-a');render();expect(ui.buttons.every(button=>button.disabled)).toBe(true);
    first.resolve(agent({id:'agent-a',name:'Агент a'}));await settle();ui.draft='НЕСОХРАНЁННЫЙ ПРОМПТ';expect(render()).toContain(ui.draft);expect(ui.editor?.agent.id).toBe('agent-a');expect(agentCatalogApi.get).toHaveBeenCalledOnce();
});
it('Поздний A старого owner не заменяет B draft и не освобождает активный lock B (ABA)',async()=>{
    const first=deferred<ICatalogAgent>(),second=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);render();await settle();ui.buttons[0].onClick();
    ui.owner='admin-b';render();await settle();ui.buttons[1].onClick();first.resolve(agent({id:'agent-a'}));await settle();expect(ui.editor).toBeUndefined();expect(ui.buttons.every(button=>button.disabled)).toBe(true);
    ui.buttons[0].onClick();expect(agentCatalogApi.get).toHaveBeenCalledTimes(2);second.resolve(agent({id:'agent-b',name:'Агент b'}));await settle();ui.draft='B DRAFT';expect(render()).toContain('B DRAFT');expect(ui.editor?.agent.id).toBe('agent-b');
});
it('Поздний A после открытия B не заменяет уже введённый B prompt',async()=>{
    const first=deferred<ICatalogAgent>(),second=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);render();await settle();ui.buttons[0].onClick();
    ui.owner='admin-b';render();await settle();ui.buttons[1].onClick();second.resolve(agent({id:'agent-b',name:'Агент b'}));await settle();ui.draft='СОХРАНИ B DRAFT';render();
    first.resolve(agent({id:'agent-a',name:'Агент a'}));await settle();expect(render()).toContain('СОХРАНИ B DRAFT');expect(ui.editor?.agent.id).toBe('agent-b');
});
it('Ошибка открытия отпускает lock для повторного запроса, обычный refresh не сбрасывает draft',async()=>{
    vi.mocked(agentCatalogApi.get).mockRejectedValueOnce(new Error('Нет сети')).mockResolvedValueOnce(agent({id:'agent-b',name:'Агент b'}));render();await settle();ui.buttons[0].onClick();await settle();expect(ui.buttons.every(button=>!button.disabled)).toBe(true);
    ui.buttons[1].onClick();await settle();ui.draft='МОЙ PROMPT';await ui.editor!.onSaved();expect(render()).toContain('МОЙ PROMPT');expect(ui.editor?.agent.id).toBe('agent-b');
});
it('Локальная упаковка остаётся доступна при отказе внешнего источника и открывается штатным редактором',async()=>{
    const local={...source.assets[0],id:'local-agent',name:'Локальный агент',imported:{...source.assets[0].imported,id:'agent-local'}};
    vi.mocked(baseApi.get).mockResolvedValue({data:{source:{verified:false,error:'GitHub недоступен'},assets:[],localAssets:[local]}});
    vi.mocked(agentCatalogApi.get).mockResolvedValue(agent({id:'agent-local',name:'Локальный агент'}));
    render();const html=await settle();expect(html).toContain('GitHub недоступен');expect(html).toContain('Упакованные на этой площадке');expect(html).toContain('Локальный агент');
    expect(ui.buttons[0].disabled).toBeFalsy();ui.buttons[0].onClick();await settle();expect(agentCatalogApi.get).toHaveBeenCalledExactlyOnceWith('agent-local');expect(ui.editor?.agent.id).toBe('agent-local');
    expect(ui.archives[0]).toMatchObject({kind:'agent',id:'agent-local'});expect(ui.archives[0].disabled).toBeFalsy();
});
it('Локальный поиск и поиск репозитория независимы; пустой результат не прячет поиск',async()=>{
    const local={...source.assets[0],id:'local-agent',name:'Особый помощник'};
    vi.mocked(baseApi.get).mockResolvedValue({data:{...source,localAssets:[local]}});render();await settle();
    ui.searches.get('Поиск локальных упаковок')!.onChange({target:{value:'несуществующий'}});let html=render();expect(html).toContain('Локальных упаковок по этому запросу нет.');expect(html).toContain('Агент a');expect(html).toContain('Агент b');
    ui.searches.get('Поиск ассетов в репозитории')!.onChange({target:{value:'Агент b'}});html=render();expect(html).toContain('Агент b');expect(html).not.toContain('Агент a');
    ui.searches.get('Поиск локальных упаковок')!.onChange({target:{value:'Особый'}});html=render();expect(html).toContain('Особый помощник');expect(html).toContain('Агент b');expect(html).not.toContain('Агент a');
});
it.each(['SUCCEEDED','RUNNING','FAILED'])('Результат импорта %s остаётся доступным без длинного отчёта по умолчанию после успеха',async state=>{
    ui.job={id:'job',planDigest:'a'.repeat(64),state,message:'Фактический результат',items:[{id:'one',kind:'agent',name:'Первый',version:'1',current:true,action:'create',state:'DONE'}]};
    render();const html=await settle();expect(html).toContain('Фактический результат');expect(html).toContain('Результаты · 1');expect(html.includes('<details open')).toBe(state!=='SUCCEEDED');
});
it('Подтверждённая остановка видна, повторная остановка недоступна',async()=>{
    ui.job={id:'job',planDigest:'a'.repeat(64),state:'RUNNING',message:'Обрабатываем второй инструмент',cancelRequested:true,items:[]};
    render();const html=await settle();
    expect(html).toContain('Остановка запрошена');
    expect(archiveUi.buttons.find(button=>button.label==='Остановка запрошена')?.disabled).toBe(true);
    expect(archiveUi.buttons.some(button=>button.label==='Остановить импорт')).toBe(false);
    expect(archiveUi.buttons.some(button=>button.label==='Новый выбор')).toBe(false);
});
it('После частичной отмены виден сохранённый результат и новый выбор без раскрытого отчёта',async()=>{
    ui.job={id:'job',planDigest:'a'.repeat(64),state:'CANCELLED',message:'Обрабатываем второй инструмент',items:[
        {id:'one',kind:'agent',name:'Первый',version:'1',current:true,action:'create',state:'SUCCEEDED'},
        {id:'two',kind:'agent',name:'Второй',version:'1',current:true,action:'create',state:'PENDING'},
    ]};
    render();const html=await settle();expect(html).toContain('Импорт остановлен.');expect(html).toContain('Готово: 1 из 2.');
    expect(html).not.toContain('Обрабатываем второй инструмент');expect(html).not.toContain('<details open');
    expect(archiveUi.buttons.some(button=>button.label==='Новый выбор'&&!button.disabled)).toBe(true);
});
it('Подготовка плана показывает состояние без пустого списка результатов',async()=>{
    ui.job={id:'job',planDigest:'a'.repeat(64),state:'QUEUED',message:'Проверяем выбранные ассеты и точные зависимости',items:[]};
    render();const html=await settle();expect(html).toContain('Проверяем выбранные ассеты');expect(html).not.toContain('Результаты · 0');
});
it('Архивная локальная упаковка предлагает восстановление; недоступная блокирует изменение',async()=>{
    const local=source.assets.map((asset,index)=>({...asset,id:'local-'+index,imported:{...asset.imported,...(index?{unavailable:true}:{archived:true})}}));
    vi.mocked(baseApi.get).mockResolvedValue({data:{...source,assets:[],localAssets:local}});render();await settle();
    expect(ui.buttons.every(button=>button.disabled)).toBe(true);expect(ui.archives[0]).toMatchObject({restore:true});expect(ui.archives[0].disabled).toBeFalsy();expect(ui.archives[1]).toMatchObject({disabled:true});
});
it('Обновить список перечитывает локальные карточки GET без сетевого обновления GitHub',async()=>{
    render();await settle();vi.mocked(baseApi.get).mockClear();ui.refreshButtons.get('Обновить список')!.onClick();await settle();
    expect(baseApi.get).toHaveBeenCalledExactlyOnceWith('/api/asset-sources');expect(baseApi.post).not.toHaveBeenCalled();
    ui.refreshButtons.get('Обновить источник')!.onClick();await settle();expect(baseApi.post).toHaveBeenCalledExactlyOnceWith('/api/asset-sources/refresh');
});
it('Автономный источник показывает закреплённую локальную поставку и явно перечитывает её',async()=>{
    const offline={...source,source:{...source.source,mode:'offline',error:'Сохранённая ошибка источника'}};vi.mocked(baseApi.get).mockResolvedValue({data:offline});vi.mocked(baseApi.post).mockResolvedValue({data:offline});
    render();const html=await settle();expect(html).toContain('Автономная поставка');expect(html).toContain('Локальная поставка · aaaaaaaa');expect(html).toContain('GitHub не запрашивается');expect(html).toContain('Сохранённая ошибка источника');expect(html).not.toContain('Обновить источник');expect(baseApi.post).not.toHaveBeenCalled();
    ui.refreshButtons.get('Перечитать поставку')!.onClick();await settle();expect(baseApi.post).toHaveBeenCalledExactlyOnceWith('/api/asset-sources/refresh');expect(render()).toContain('Агент a');
});
it.each(['online','offline'])('Пустой непроверенный источник предлагает архив и подходящий режим обновления: %s',async mode=>{
    vi.mocked(baseApi.get).mockResolvedValue({data:{source:{mode,verified:false},assets:[]}});render();const html=await settle(),action=mode==='offline'?'перечитайте локальную поставку':'обновите источник';
    expect(html).toContain('Загрузите архив или '+action+'.');expect(archiveUi.emptyDescription).toBe('Загрузите архив или '+action+', чтобы выбрать ассеты.');expect(html).not.toContain('скачиваются только небольшие описи');expect(baseApi.post).not.toHaveBeenCalled();
});
it.each(['create','conflict'])('NEEDS_INPUT предлагает повтор исправленной поставки, а проверку конфликта только для action=conflict: %s',async action=>{
    ui.job={id:'missing-offline-blob',planDigest:'a'.repeat(64),state:'NEEDS_INPUT',message:'Файлы выбранного ассета отсутствуют в локальной поставке.',items:[{id:'bridge',kind:'bridge',name:'Мост',version:'0.9.17',current:true,action,state:'FAILED'}]};
    render();const html=await settle(),label=action==='conflict'?'Проверить конфликт заново':'Повторить после исправления';
    expect(html).toContain(label);expect(html).not.toContain(action==='conflict'?'Повторить после исправления':'Проверить конфликт заново');expect(html).not.toContain('Решить конфликт');
    ui.retryButton!();expect(ui.retry).toHaveBeenCalledOnce();
});
it.each(['response','error']as const)('Live refresh защищён от позднего старого GET: %s',async mode=>{
    render();await settle();const old=deferred<{data:typeof source}>(),next=deferred<{data:typeof source}>();
    vi.mocked(baseApi.get).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);ui.live();ui.live();render();expect(ui.refreshButtons.get('Обновить список')?.loading).toBe(true);
    next.resolve({data:{...source,assets:[{...source.assets[0],name:'Новый проверенный результат'}]}});await settle();
    if(mode==='response')old.resolve({data:{...source,assets:[{...source.assets[0],name:'Старый ответ'}]}});else old.reject(new Error('Старая ошибка'));
    const html=await settle();expect(html).toContain('Новый проверенный результат');expect(html).not.toContain('Старый ответ');expect(html).not.toContain('Старая ошибка');expect(ui.refreshButtons.get('Обновить список')?.loading).toBe(false);
});

const uploaded={...source,source:{...source.source,mode:'online',archiveSha256:'c'.repeat(64)},assets:source.assets.map((asset,index)=>({...asset,imported:undefined,name:index?'Неполный MCP':'Готовый агент',supply:index?{ready:false,missingFiles:2,missingBytes:1048576}:{ready:true,missingFiles:0,missingBytes:0}}))};
it('Автономное перечитывание архива объясняет проверку выбранной описи без переключения источника',async()=>{
    vi.mocked(baseApi.get).mockResolvedValue({data:{...uploaded,source:{...uploaded.source,mode:'offline'}}});render();const html=await settle();expect(html).toContain('перепроверяет выбранную локальную опись без обращения к GitHub');expect(html).not.toContain('переключает список');expect(html).toContain('Из архива / без сетевой дозагрузки');
});
it('Проверенный архив показывает готовые карточки; неполный граф заблокирован, выбор не дублируется',async()=>{
    vi.mocked(baseApi.put).mockResolvedValue({data:uploaded});render();await settle();expect(render()).toContain('Импортировать архив');
    expect(await archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'))).toBe(true);const html=render();expect(html).toContain('Из архива / без сетевой дозагрузки');expect(html).toContain('Не хватает файлов: 2');expect(html).toContain('Проверить источник в GitHub');
    expect(archiveUi.checkboxes.map(box=>!!box.disabled)).toEqual([false,true]);expect(archiveUi.buttons.filter(button=>button.label==='Добавить').map(button=>!!button.disabled)).toEqual([false,true]);
    archiveUi.buttons.find(button=>button.label==='Добавить'&&button.disabled)!.onClick();expect(archiveUi.start).not.toHaveBeenCalled();
    archiveUi.checkboxes[0].onChange({target:{checked:true}});archiveUi.checkboxes[0].onChange({target:{checked:true}});expect(render()).toContain('Импортировать выбранные (1)');
    // The bulk button has React children, so the ready card also exercises the guarded canonical action.
    archiveUi.buttons.find(button=>button.label==='Добавить'&&!button.disabled)!.onClick();expect(archiveUi.start).toHaveBeenCalledExactlyOnceWith(['source-a'],'a'.repeat(40));expect(baseApi.post).not.toHaveBeenCalled();
});
it.each(['response','error']as const)('Запоздавший initial GET после загрузки архива не заменяет опись и ошибку: %s',async outcome=>{
    const initial=deferred<{data:typeof source}>();vi.mocked(baseApi.get).mockReturnValueOnce(initial.promise);vi.mocked(baseApi.put).mockResolvedValue({data:uploaded});render();
    await archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'));if(outcome==='response')initial.resolve({data:source});else initial.reject(new Error('Старая ошибка списка'));
    const html=await settle();expect(html).toContain('Готовый агент');expect(html).not.toContain('Агент a');expect(html).not.toContain('Старая ошибка списка');expect(html).toContain('Из архива / без сетевой дозагрузки');
});
it('Во время передачи live GET и импорт карточки не конкурируют с архивом; отказ сохраняет старый список',async()=>{
    render();await settle();const pending=deferred<{data:typeof uploaded}>();vi.mocked(baseApi.put).mockReturnValue(pending.promise);const uploading=archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'));render();
    const reads=vi.mocked(baseApi.get).mock.calls.length;ui.live();await settle();expect(baseApi.get).toHaveBeenCalledTimes(reads);expect(archiveUi.checkboxes.every(box=>box.disabled)).toBe(true);expect(ui.buttons.every(button=>button.disabled)).toBe(true);
    archiveUi.buttons.find(button=>button.label==='Проверить и добавить')!.onClick();expect(archiveUi.start).not.toHaveBeenCalled();pending.reject(new Error('Некорректный ZIP'));await uploading;
    expect(render()).toContain('Агент a');expect(archiveUi.modal!.upload.error).toBe('Некорректный ZIP');expect(archiveUi.modal!.upload.busy).toBe(false);
});
it('Активный импорт, запрос редактора и несохранённый редактор блокируют новый архив',async()=>{
    render();await settle();archiveUi.blocked=true;render();expect(archiveUi.buttons.find(button=>button.label==='Импортировать архив')!.disabled).toBe(true);expect(await archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'))).toBe(false);
    archiveUi.blocked=false;render();const editor=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValue(editor.promise);ui.buttons[0].onClick();render();expect(archiveUi.modal!.blocked).toBe(true);
    editor.resolve(agent({id:'agent-a'}));await settle();expect(archiveUi.modal!.blocked).toBe(true);expect(await archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'))).toBe(false);expect(baseApi.put).not.toHaveBeenCalled();
});
it('Проверка GitHub блокирует архив до завершения POST даже при live обновлении',async()=>{
    render();await settle();const pending=deferred<{data:typeof source}>();vi.mocked(baseApi.post).mockReturnValue(pending.promise);ui.refreshButtons.get('Обновить источник')!.onClick();render();
    ui.live();await settle();expect(archiveUi.modal!.blocked).toBe(true);expect(await archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'))).toBe(false);expect(baseApi.put).not.toHaveBeenCalled();pending.resolve({data:source});await settle();expect(archiveUi.modal!.blocked).toBe(false);
});
it('Старый обработчик проверки источника после смены роли не запускает POST',async()=>{
    render();await settle();const previous=ui.refreshButtons.get('Обновить источник')!;ui.owner='admin-b';render();await settle();previous.onClick();await settle();expect(baseApi.post).not.toHaveBeenCalled();
});
it('Перечитывание снимает прежний выбор карточки, если её файлы теперь недоступны',async()=>{
    vi.mocked(baseApi.get).mockResolvedValue({data:uploaded});render();await settle();archiveUi.checkboxes[0].onChange({target:{checked:true}});expect(render()).toContain('Импортировать выбранные (1)');
    vi.mocked(baseApi.get).mockResolvedValue({data:{...uploaded,assets:uploaded.assets.map(asset=>({...asset,supply:{ready:false,missingFiles:1,missingBytes:64}}))}});ui.refreshButtons.get('Обновить список')!.onClick();const html=await settle();expect(html).not.toContain('Импортировать выбранные (1)');expect(archiveUi.checkboxes.every(box=>!box.checked&&box.disabled)).toBe(true);expect(html).toContain('64 Б');
});
it('Запрос редактора блокирует upload синхронно, до следующего render',async()=>{
    render();await settle();const pending=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValue(pending.promise);ui.buttons[0].onClick();expect(await archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'))).toBe(false);expect(baseApi.put).not.toHaveBeenCalled();pending.resolve(agent({id:'agent-a'}));await settle();
});
it('Нажатие добавить карточку блокирует upload до ответа POST и нового render',async()=>{
    vi.mocked(baseApi.get).mockResolvedValue({data:uploaded});render();await settle();const pending=deferred<void>();archiveUi.start.mockReturnValueOnce(pending.promise);archiveUi.buttons.find(button=>button.label==='Добавить'&&!button.disabled)!.onClick();expect(await archiveUi.modal!.upload.upload(new File(['zip'],'source.zip'))).toBe(false);expect(baseApi.put).not.toHaveBeenCalled();pending.resolve();await settle();
});

it('Архив объясняет три шага обновления и позволяет дополнить неполную поставку',async()=>{
    vi.mocked(baseApi.get).mockResolvedValue({data:uploaded});render();const html=await settle();
    expect(html).toContain('Опись архива проверена');expect(html).toContain('Файлы готовы: 1 из 2');expect(html).toContain('полную опись и описания ассетов');
    expect(html).toContain('Загрузка архива не меняет версии общего каталога и проектов');
    expect(html).toContain('Закрепить новую версию');expect(html).toContain('Обновить шаблон');
    const complete=archiveUi.buttons.find(button=>button.label==='Дополнить поставку архивом');expect(complete?.disabled).toBe(false);
    complete!.onClick();render();expect(archiveUi.modal?.open).toBe(true);
});
it('Выбор обновлений включает только готовые доступные карточки с новой версией и ничего не отправляет',async()=>{
    const assets=[
        {...source.assets[0],id:'ready-update',supply:{ready:true,missingFiles:0,missingBytes:0},imported:{...source.assets[0].imported,updateAvailable:true}},
        {...source.assets[1],id:'missing-update',supply:{ready:false,missingFiles:1,missingBytes:64},imported:{...source.assets[1].imported,updateAvailable:true}},
        {...source.assets[1],id:'current'},
        {...source.assets[1],id:'archived-update',imported:{...source.assets[1].imported,updateAvailable:true,archived:true}},
    ];
    vi.mocked(baseApi.get).mockResolvedValue({data:{...uploaded,assets}});render();await settle();
    archiveUi.buttons.find(button=>button.label==='Выбрать готовые обновления')!.onClick();render();
    expect(archiveUi.checkboxes.filter(box=>box.checked).map(box=>box['aria-label'])).toEqual(['Выбрать Агент a']);
    expect(archiveUi.start).not.toHaveBeenCalled();expect(baseApi.post).not.toHaveBeenCalled();
    archiveUi.blocked=true;render();expect(archiveUi.buttons.find(button=>button.label==='Выбрать готовые обновления')?.disabled).toBe(true);
});

it('После загрузки поставки новые версии показаны перед прежними локальными упаковками',async()=>{
    const local={...source.assets[0],id:'local',name:'Прежняя упаковка'};
    vi.mocked(baseApi.get).mockResolvedValue({data:{...uploaded,localAssets:[local]}});render();const html=await settle();
    expect(html.indexOf('Из репозитория ассетов')).toBeLessThan(html.indexOf('Упакованные на этой площадке'));
    expect(html).toContain('Открыть в каталоге');
});

it('Массовый выбор обновлений ограничен серверной порцией из 50 карточек',async()=>{
    const assets=Array.from({length:51},(_,index)=>({...source.assets[0],id:'update-'+index,name:'Update '+index,imported:{...source.assets[0].imported,updateAvailable:true}}));
    vi.mocked(baseApi.get).mockResolvedValue({data:{...uploaded,assets}});render();await settle();
    archiveUi.buttons.find(button=>button.label==='Выбрать готовые обновления')!.onClick();const html=render();
    expect(archiveUi.checkboxes.filter(box=>box.checked)).toHaveLength(50);expect(html).toContain('первые 50');expect(html).toContain('Импортировать выбранные (50)');expect(archiveUi.start).not.toHaveBeenCalled();
});
