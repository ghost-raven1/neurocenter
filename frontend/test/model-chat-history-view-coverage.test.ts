import {createElement,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChatResearchHistory} from '../src/features/ModelChat/ChatResearchHistory';
import type {IChatResearchStepSummary,IModelChatResponse} from '../src/features/ModelChat/types';
const hooks=vi.hoisted(()=>{let value=false;return{reset:()=>{value=false;},state:()=>[value,(next:boolean)=>{value=next;}]};});
const ui=vi.hoisted(()=>({history:{page:undefined as {items:IChatResearchStepSummary[];history:{hasMore:boolean;nextCursor:string|null}}|undefined,loading:false,error:'',more:vi.fn(),retry:vi.fn()},args:[]as unknown[],steps:[]as IChatResearchStepSummary[],buttons:new Map<string,()=>void>()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state}));
vi.mock('../src/features/ModelChat/useChatResearchHistory',()=>({useChatResearchHistory:(...args:unknown[])=>{ui.args=args;return ui.history;}}));
vi.mock('../src/features/ModelChat/ChatResearchActivity',()=>({ChatResearchStep:({step,conversationId}:{step:IChatResearchStepSummary;conversationId:string})=>{ui.steps.push(step);return createElement('p',{'data-conversation':conversationId},step.id);}}));
vi.mock('antd',()=>({Alert:({message}:{message:string})=>createElement('p',{role:'alert'},message),Spin:()=>createElement('span',{role:'status'},'Читаем историю'),Typography:{Text:({children}:{children:ReactNode})=>children},Button:({children,onClick}:{children:string;onClick:()=>void})=>{ui.buttons.set(children,onClick);return createElement('button',null,children);}}));
const step=(id:string,responseId:string|null=null):IChatResearchStepSummary=>({id,responseId,conversationId:'chat-one',turnId:'turn-one',requestId:'request-one',attempt:3,sequence:1,kind:'project_read',status:'done',error:null,outputBytes:10,createdAt:'',updatedAt:''});
const render=(responses?:IModelChatResponse[])=>ChatResearchHistory({conversationId:'chat-one',turnId:'turn-one',requestId:'request-one',responses})as ReactElement<{onToggle:(event:{currentTarget:{open:boolean}})=>void}>;
const opened=(responses?:IModelChatResponse[])=>{render(responses).props.onToggle({currentTarget:{open:true}});return renderToStaticMarkup(render(responses));};
beforeEach(()=>{hooks.reset();vi.clearAllMocks();ui.args=[];ui.steps=[];ui.buttons.clear();ui.history.page=undefined;ui.history.loading=false;ui.history.error='';});
afterEach(()=>hooks.reset());

describe('Просмотр всех попыток исследования',()=>{
    it('По умолчанию свернут и передаёт hook личный scope без загрузки outputs',()=>{
        const html=renderToStaticMarkup(render());expect(html).toContain('Все попытки исследования');expect(html).not.toContain('Сохранённых шагов');expect(ui.args).toEqual([false,'chat-one','turn-one','request-one']);expect(ui.steps).toEqual([]);
    });
    it('Открывает конкретные metadata steps и сохраняет имя автора каждой групповой попытки',()=>{
        ui.history.page={items:[step('one','response-dev'),step('two','response-missing'),step('three')],history:{hasMore:true,nextCursor:'three'}};
        const html=opened([{id:'response-dev',name:'Разработчик'}as IModelChatResponse]);expect(html).toContain('Разработчик');expect(html).toContain('Участник группы');expect(html).toContain('попытка 3');expect(ui.steps.map(item=>item.id)).toEqual(['one','two','three']);expect(ui.args[0]).toBe(true);
        ui.buttons.get('Показать ещё шаги')!();expect(ui.history.more).toHaveBeenCalledOnce();expect(ui.history.retry).not.toHaveBeenCalled();
    });
    it('Без списка участников честно показывает нейтрального автора вместо выдуманного имени',()=>{
        ui.history.page={items:[step('one','response-deleted')],history:{hasMore:false,nextCursor:null}};expect(opened()).toContain('Участник группы');expect(ui.buttons.has('Показать ещё шаги')).toBe(false);
    });
    it('Ошибка страницы не прячет уже загруженные шаги и предлагает только retry чтения',()=>{
        ui.history.page={items:[step('one')],history:{hasMore:true,nextCursor:'one'}};ui.history.error='История временно недоступна';const html=opened();expect(html).toContain('История временно недоступна');expect(html).toContain('one');expect(ui.buttons.has('Показать ещё шаги')).toBe(false);ui.buttons.get('Повторить загрузку попыток')!();expect(ui.history.retry).toHaveBeenCalledOnce();
    });
    it('В процессе чтения не объявляет историю пустой и не предлагает параллельную следующую страницу',()=>{
        ui.history.loading=true;expect(opened()).toContain('Читаем историю');expect(opened()).not.toContain('Сохранённых шагов пока нет');expect(ui.buttons.size).toBe(0);
    });
    it('Пустая завершённая страница имеет честный статус, закрытие выключает hook',()=>{
        ui.history.page={items:[],history:{hasMore:false,nextCursor:null}};expect(opened()).toContain('Сохранённых шагов пока нет');render().props.onToggle({currentTarget:{open:false}});expect(renderToStaticMarkup(render())).not.toContain('Сохранённых шагов');expect(ui.args[0]).toBe(false);
    });
});
