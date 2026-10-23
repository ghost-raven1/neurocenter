import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import ChatOverlay from '../src/features/ModelChat/ChatOverlay';
import {modelChatApi} from '../src/features/ModelChat/api';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
import {openModelChat,routeChatProject} from '../src/features/ModelChat/chatNavigation';
import type {ChatWorkspace} from '../src/features/ModelChat/ChatWorkspace';
import {detail,model} from './model-chat-fixtures';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        state:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return[slot.value,(value:unknown)=>{slot.value=typeof value==='function'?value(slot.value):value;}];},
        ref:(value:unknown)=>(slots[cursor++]??={value:{current:value}}).value,
        callback:(value:unknown,deps:unknown[])=>{const i=cursor++,old=slots[i];if(old&&same(old.deps,deps))return old.value;slots[i]={value,deps};return value;},
        effect:(effect:()=>void|(()=>void),deps:unknown[])=>{const i=cursor++,old=slots[i];if(old&&same(old.deps,deps))return;const slot=slots[i]={deps};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});}};
});
type WorkspaceProps=Parameters<typeof ChatWorkspace>[0];
const ui=vi.hoisted(()=>({owner:'alice',ready:true,projects:[{id:'prj-one',name:'Проект'}],models:[]as ICatalogModel[],modelLoading:false,modelError:'',workspace:undefined as WorkspaceProps|undefined,team:undefined as {projectId:string;projectName?:string}|undefined,radios:new Map<string,{onChange:(event:{target:{value:string}})=>void}>(),selects:new Map<string,{options:Array<{value:string}>;onChange:(value:string)=>void;disabled?:boolean;value?:string}>(),dialogs:[]as Array<{onSelect:(id:string)=>void}>,closed:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state,useRef:hooks.ref,useCallback:hooks.callback,useEffect:hooks.effect}));
vi.mock('react-redux',()=>({useSelector:()=>({activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]})}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:vi.fn()})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner;return{scope:owner,captureOwner:()=>()=>owner===ui.owner};}}));
vi.mock('../src/modules/Projects/useAvailableProjects',()=>({useAvailableProjects:()=>({projects:ui.projects,ready:ui.ready,loading:!ui.ready,error:'',refresh:vi.fn()})}));
vi.mock('../src/features/ModelCatalog/useModelCatalog',()=>({useModelCatalog:()=>({catalog:{items:ui.models,assignedModelIds:ui.models.map(value=>value.id)},loading:ui.modelLoading,error:ui.modelError,refresh:vi.fn()})}));
vi.mock('../src/features/ModelChat/api',()=>({modelChatApi:{list:vi.fn(),read:vi.fn()}}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{get:vi.fn()}}));
vi.mock('../src/features/ModelChat/ChatWorkspace',()=>({ChatWorkspace:(props:WorkspaceProps)=>{ui.workspace=props;return createElement('section',{'data-workspace':true},props.navigation?.controls(action=>action()));}}));
vi.mock('../src/features/ProjectChat/ProjectChatWorkspace',()=>({ProjectChatWorkspace:(props:{projectId:string;projectName?:string})=>{ui.team=props;return createElement('section',{'data-project-team':true},'Общая команда');}}));
vi.mock('../src/features/ModelChat/ConversationList',()=>({ConversationList:(props:typeof ui.dialogs[number])=>{ui.dialogs.push(props);return null;}}));
vi.mock('antd',()=>{const content=({children}:{children?:ReactNode})=>children;return{Modal:content,Button:content,Spin:()=>null,Typography:{Text:content},Empty:({description}:{description:string})=>createElement('p',null,description),Alert:({message}:{message:string})=>createElement('p',{role:'alert'},message),Radio:{Group:(props:{'aria-label':string;onChange:(event:{target:{value:string}})=>void})=>{ui.radios.set(props['aria-label'],props);return null;}},Select:(props:{'aria-label':string}&ReturnType<typeof ui.selects.get>)=>{ui.selects.set(props['aria-label'],props);return null;}};});
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function render(projectId:string|undefined='prj-one',group=false,team=false){hooks.begin();ui.dialogs=[];ui.selects.clear();ui.radios.clear();const html=renderToStaticMarkup(createElement(ChatOverlay,{projectId,group,team,onClose:ui.closed}));hooks.commit();return html;}
beforeEach(()=>{hooks.dispose();vi.clearAllMocks();ui.owner='alice';ui.ready=true;ui.projects=[{id:'prj-one',name:'Проект'}];ui.models=[model];ui.modelLoading=false;ui.modelError='';ui.workspace=undefined;ui.team=undefined;vi.mocked(modelChatApi.list).mockResolvedValue([]);vi.mocked(modelChatApi.read).mockResolvedValue(detail({turns:[]}));vi.mocked(modelCatalogApi.get).mockResolvedValue(model);});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();});

describe('Единый чат из шапки',()=>{
    it('Не выбирает модель и не создаёт диалог неявно, список загружается сразу по проекту',async()=>{expect(render()).toContain('Выберите модель');await flush();expect(ui.workspace).toBeUndefined();expect(modelChatApi.list).toHaveBeenCalledWith(undefined,'prj-one',expect.any(AbortSignal));expect(modelChatApi.read).not.toHaveBeenCalled();render();expect(ui.selects.get('Модель чата')?.value).toBeUndefined();});
    it('Явный выбор открывает общий workspace, intent из агентов показывает inline group setup',async()=>{render('prj-one',true);ui.selects.get('Модель чата')!.onChange(model.id);render('prj-one',true);expect(ui.workspace?.navigation?.initialGroup).toBe(true);expect(ui.workspace?.model.id).toBe(model.id);expect(ui.workspace?.navigation?.initialDetail).toBeUndefined();expect(modelChatApi.read).not.toHaveBeenCalled();});
    it('Сохранённая группа открывается с собственной моделью и прежней историей',async()=>{const saved=detail({conversation:{...detail().conversation,mode:'group'},turns:[]});vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]);vi.mocked(modelChatApi.read).mockResolvedValue(saved);render();await flush();render();ui.dialogs[0].onSelect(saved.conversation.id);await flush();render();expect(modelCatalogApi.get).toHaveBeenCalledWith(saved.conversation.modelId);expect(ui.workspace?.navigation?.initialDetail).toEqual(saved);expect(ui.workspace?.model.id).toBe(saved.conversation.modelId);});
    it('Поздний ответ прежнего владельца не открывает приватную историю',async()=>{let resolve!:(value:ReturnType<typeof detail>)=>void;vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]);vi.mocked(modelChatApi.read).mockReturnValue(new Promise(done=>{resolve=done;}));render();await flush();render();ui.dialogs[0].onSelect(detail().conversation.id);ui.owner='bob';resolve(detail());await flush();expect(ui.workspace).toBeUndefined();});
    it('Отказ чтения остаётся ошибкой, не подменяет историю пустым новым диалогом',async()=>{vi.mocked(modelChatApi.list).mockResolvedValue([detail().conversation]);vi.mocked(modelChatApi.read).mockRejectedValue(new Error('Доступ к диалогу отозван'));render();await flush();render();ui.dialogs[0].onSelect(detail().conversation.id);await flush();expect(render()).toContain('Доступ к диалогу отозван');expect(ui.workspace).toBeUndefined();});
    it('Непроверенные и embedding-модели нельзя выбрать для нового чата',()=>{ui.models=[{...model,verificationSha256:null,manifestSha256:null},{...model,id:'embedding',capability:'embedding'}];render();expect(ui.selects.get('Модель чата')?.options).toEqual([]);expect(render()).toContain('нет готовой модели');});
    it('Алиас проекта разрешается до показа рабочего контекста и закреплённый ID сохраняется при live rename',()=>{ui.ready=false;expect(render('Проект')).not.toContain('Выберите модель');expect(ui.selects.size).toBe(0);ui.ready=true;render('Проект');render('Проект');expect(ui.selects.get('Проект чата')?.value).toBe('prj-one');ui.projects=[{id:'prj-one',name:'Новое имя'}];render('Проект');expect(ui.selects.get('Проект чата')?.value).toBe('prj-one');});
    it('Команда проекта открывается отдельно от приватной истории и не требует модели',async()=>{render('prj-one',false,true);await vi.dynamicImportSettled();render('prj-one',false,true);expect(ui.team).toEqual({projectId:'prj-one',projectName:'Проект'});expect(modelChatApi.list).not.toHaveBeenCalled();expect(modelChatApi.read).not.toHaveBeenCalled();expect(ui.selects.has('Модель чата')).toBe(false);ui.radios.get('Режим чата')!.onChange({target:{value:'personal'}});render('prj-one',false,true);await flush();expect(modelChatApi.list).toHaveBeenCalledWith(undefined,'prj-one',expect.any(AbortSignal));});
    it('Route helpers не смешивают проектную страницу с общим списком и не открывают новый таб',()=>{expect(routeChatProject('/projects/prj-one','')).toBe('prj-one');expect(routeChatProject('/projects','')).toBeUndefined();expect(routeChatProject('/store','?p=Проект')).toBe('Проект');const dispatchEvent=vi.fn();vi.stubGlobal('window',{dispatchEvent});vi.stubGlobal('CustomEvent',class{constructor(readonly type:string,readonly options:{detail:unknown}){}});openModelChat({projectId:'prj-one',group:true});expect(dispatchEvent.mock.calls[0][0]).toMatchObject({type:'neurocenter:open-chat',options:{detail:{projectId:'prj-one',group:true}}});});
});
