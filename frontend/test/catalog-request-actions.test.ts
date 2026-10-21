import './feature-flags-enabled';
import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {RequestActions} from '../src/features/CatalogRequests/RequestActions';
import {catalogRequestsApi} from '../src/features/CatalogRequests/api';
import {requestActionPayload} from '../src/features/CatalogRequests/model';
import {requestDetail} from './catalog-request-fixtures';
import type {IRequestDetail} from '../src/features/CatalogRequests/types';
const ui=vi.hoisted(()=>({cursor:0,slots:[] as Array<{value:unknown}>,owner:'reviewer',epoch:0,values:{} as Record<string,unknown>,finish:undefined as ((values:Record<string,unknown>)=>void)|undefined,buttons:new Map<string,()=>void>(),fields:[] as Array<Record<string,unknown>>,form:{resetFields:()=>{ui.values={};},setFieldsValue:(value:Record<string,unknown>)=>{Object.assign(ui.values,value);ui.fields.push(value);},submit:()=>ui.finish?.(ui.values)}}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
    useState:(initial:unknown)=>{const slot=ui.slots[ui.cursor++]??={value:initial};return[slot.value,(value:unknown)=>{slot.value=typeof value==='function'?(value as (old:unknown)=>unknown)(slot.value):value;}];},
    useRef:(initial:unknown)=>{const index=ui.cursor++;return(ui.slots[index]??={value:{current:initial}}).value;},
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner,epoch=ui.epoch;return{captureOwner:()=>()=>owner===ui.owner&&epoch===ui.epoch};}}));
vi.mock('../src/features/CatalogRequests/RequestTargetPicker',()=>({RequestTargetPicker:()=>null}));
vi.mock('../src/features/CatalogRequests/api',()=>({catalogRequestsApi:{action:vi.fn()}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Modal:({children,open}:{children?:ReactNode;open:boolean})=>open?children:null,Space:content,Popconfirm:content,Input:{TextArea:()=>null},Alert:({message,description,action}:{message:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',null,message,description,action),
        Form:Object.assign(({children,onFinish}:{children?:ReactNode;onFinish:typeof ui.finish})=>{ui.finish=onFinish;return children;},{useForm:()=>[ui.form],Item:content}),
        Button:({children,onClick,disabled}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean})=>{if(onClick&&!disabled)ui.buttons.set(String(children),onClick);return children;}};
});
const onSaved=vi.fn(),onRefresh=vi.fn();
function render(value=requestDetail()){ui.cursor=0;ui.buttons.clear();return renderToStaticMarkup(createElement(RequestActions,{request:value,onSaved,onRefresh}));}
const reviewer=(changes:Partial<IRequestDetail>={})=>requestDetail({permissions:{canEdit:false,canCancel:false,canReview:true,canResubmit:false},...changes});
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
beforeEach(()=>{vi.clearAllMocks();ui.slots=[];ui.cursor=0;ui.owner='reviewer';ui.epoch=0;ui.values={};ui.fields=[];ui.buttons.clear();vi.mocked(catalogRequestsApi.action).mockResolvedValue(requestDetail({status:'in_progress',revision:2}));});
describe('Review lifecycle and immutable action acknowledgement',()=>{
    it('Request permissions govern owner/reviewer actions; completion is available only in_progress',()=>{
        const owner=render();expect(owner).not.toContain('Взять в работу');expect(owner).not.toContain('Отклонить');expect(owner).not.toContain('Завершить');
        const submitted=render(reviewer());expect(submitted).toContain('Взять в работу');expect(submitted).not.toContain('Завершить');
        const inProgress=render(reviewer({status:'in_progress'}));expect(inProgress).toContain('Завершить');expect(inProgress).not.toContain('Взять в работу');
        const clarification=render(reviewer({status:'needs_info',permissions:{canEdit:true,canCancel:true,canReview:false,canResubmit:true}}));expect(clarification).toContain('Отправить на рассмотрение');expect(clarification).not.toContain('Запросить уточнение');
    });
    it('Start carries the exact request revision and prevents duplicate clicks',async()=>{
        let resolve!:(value:IRequestDetail)=>void;vi.mocked(catalogRequestsApi.action).mockReturnValue(new Promise(done=>{resolve=done;}));render(reviewer());ui.buttons.get('Взять в работу')!();ui.buttons.get('Взять в работу')!();await flush();expect(catalogRequestsApi.action).toHaveBeenCalledOnce();expect(vi.mocked(catalogRequestsApi.action).mock.calls[0].slice(0,3)).toEqual([requestDetail().id,{action:'start'},1]);resolve(requestDetail({status:'in_progress',revision:2}));await flush();expect(onSaved).toHaveBeenCalledOnce();
    });
    it('Lost start response retries the same action key and revision',async()=>{
        vi.mocked(catalogRequestsApi.action).mockRejectedValueOnce(new Error('Lost ACK'));render(reviewer());ui.buttons.get('Взять в работу')!();await flush();const original=vi.mocked(catalogRequestsApi.action).mock.calls[0];expect(render(reviewer())).toContain('не подтверждён');ui.buttons.get('Повторить действие')!();await flush();expect(vi.mocked(catalogRequestsApi.action).mock.calls[1]).toEqual(original);
    });
    it('Completion requires a reason and actual card; issue keeps its original target',async()=>{
        const request=reviewer({status:'in_progress',revision:4});render(request);ui.buttons.get('Завершить')!();render(request);ui.finish!({comment:'  ',targetId:'card'});await flush();expect(catalogRequestsApi.action).not.toHaveBeenCalled();
        ui.finish!({comment:'Добавлено'});await flush();expect(catalogRequestsApi.action).not.toHaveBeenCalled();
        ui.finish!({comment:'  Добавлено  ',targetId:'card'});await flush();expect(vi.mocked(catalogRequestsApi.action).mock.calls[0].slice(0,3)).toEqual([request.id,{action:'complete',comment:'Добавлено',target:{type:'mcp',id:'card'}},4]);
        expect(requestActionPayload({...request,kind:'issue'},'complete',{comment:'Исправлено'})).toEqual({action:'complete',comment:'Исправлено'});
    });
    it('409 keeps comments and offers explicit refresh without silently adopting the latest revision',async()=>{
        vi.mocked(catalogRequestsApi.action).mockRejectedValueOnce({isAxiosError:true,response:{status:409,data:{message:'Изменилась'}}});const request=reviewer({status:'in_progress',revision:4});render(request);ui.buttons.get('Отклонить')!();render(request);ui.values={comment:'Причина отказа'};ui.finish!(ui.values);await flush();const html=render({...request,revision:5});expect(html).toContain('уже изменилась');expect(ui.values.comment).toBe('Причина отказа');expect(vi.mocked(catalogRequestsApi.action).mock.calls[0][2]).toBe(4);expect(onRefresh).not.toHaveBeenCalled();ui.buttons.get('Проверить актуальную заявку')!();expect(onRefresh).toHaveBeenCalledOnce();
    });
    it('Late result after a role change never overwrites or closes the new request view',async()=>{
        let resolve!:(value:IRequestDetail)=>void;vi.mocked(catalogRequestsApi.action).mockReturnValue(new Promise(done=>{resolve=done;}));render(reviewer());ui.buttons.get('Взять в работу')!();ui.owner='other';ui.epoch++;resolve(requestDetail());await flush();expect(onSaved).not.toHaveBeenCalled();
    });
});
