import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RequestDetails} from '../src/features/CatalogRequests/RequestDetails';
import {catalogRequestsApi} from '../src/features/CatalogRequests/api';
import {requestDetail} from './catalog-request-fixtures';
import type {IRequestDetail} from '../src/features/CatalogRequests/types';
const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useCallback<T>(value:T,deps:unknown[]){const index=cursor++,previous=slots[index];if(!previous||!same(previous.deps,deps))slots[index]={value,deps};return slots[index].value;},
        useEffect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const ui=vi.hoisted(()=>({buttons:new Map<string,()=>void>(),form:null as {open:boolean;request:IRequestDetail;onClose:()=>void}|null,actionSaved:undefined as ((value:IRequestDetail)=>void)|undefined}));
const owns=()=>true,captureOwner=()=>owns;
vi.mock('react',async original=>({...await original<typeof import('react')>(),...hooks}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/features/CatalogRequests/RequestActions',()=>({RequestActions:({onSaved}:{onSaved:(value:IRequestDetail)=>void})=>{ui.actionSaved=onSaved;return null;}}));
vi.mock('../src/features/CatalogRequests/RequestFormModal',()=>({RequestFormModal:(props:NonNullable<typeof ui.form>)=>{ui.form=props;return createElement('div',{'data-open':props.open},'EditDraft');}}));
vi.mock('../src/common/components/AccessibleDrawer',()=>({default:({children}:{children:ReactNode})=>children}));
vi.mock('../src/features/CatalogRequests/api',()=>({catalogRequestsApi:{get:vi.fn()}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Alert:({message,description}:{message:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),Button:({children,onClick,disabled}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean})=>{if(onClick&&!disabled)ui.buttons.set(String(children),onClick);return children;},
        Descriptions:Object.assign(content,{Item:content}),Empty:content,Space:content,Spin:content,Tag:content,Timeline:Object.assign(content,{Item:content}),Typography:{Text:content,Title:content,Paragraph:content}};
});
const id=requestDetail().id;
function render(){hooks.begin();ui.buttons.clear();ui.form=null;const html=renderToStaticMarkup(createElement(RequestDetails,{id,projects:[],onClose:()=>undefined,onChanged:()=>undefined}));hooks.commit();return html;}
async function settle(){for(let index=0;index<20;index++)await Promise.resolve();return render();}
beforeEach(()=>{vi.resetAllMocks();ui.form=null;ui.actionSaved=undefined;vi.mocked(catalogRequestsApi.get).mockResolvedValue(requestDetail());});
afterEach(()=>hooks.dispose());
describe('Закрытие редактора не уничтожает черновик заявки',()=>{
    it('Closed edit remains mounted with its original revision and can reopen after review starts',async()=>{
        render();await settle();ui.buttons.get('Редактировать заявку')!();render();const original=ui.form!.request;expect(ui.form!.open).toBe(true);
        ui.form!.onClose();render();expect(ui.form!.open).toBe(false);expect(ui.form!.request).toBe(original);
        vi.mocked(catalogRequestsApi.get).mockResolvedValue(requestDetail({revision:2,status:'in_progress',permissions:{canEdit:false,canCancel:true,canReview:false,canResubmit:false}}));
        ui.buttons.get('Обновить заявку')!();await settle();expect(ui.form!.open).toBe(false);expect(ui.form!.request).toBe(original);
        ui.buttons.get('Открыть черновик изменений')!();render();expect(ui.form!.open).toBe(true);expect(ui.form!.request.revision).toBe(1);
    });
    it('Explicit read denial removes both the private request and its retained edit draft',async()=>{
        render();await settle();ui.buttons.get('Редактировать заявку')!();render();expect(ui.form).not.toBeNull();
        vi.mocked(catalogRequestsApi.get).mockRejectedValueOnce({isAxiosError:true,response:{status:403}});ui.buttons.get('Обновить заявку')!();const html=await settle();expect(ui.form).toBeNull();expect(html).not.toContain('EditDraft');expect(html).not.toContain('Новый MCP');
    });
});
describe('Поздние ответы не откатывают видимую заявку',()=>{
    it('A slow detail revision 2 cannot replace action revision 3 already visible',async()=>{
        render();await settle();let resolve!:(value:IRequestDetail)=>void;
        vi.mocked(catalogRequestsApi.get).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
        ui.buttons.get('Обновить заявку')!();ui.actionSaved!(requestDetail({revision:3,title:'Свежая версия три'}));render();
        resolve(requestDetail({revision:2,title:'Запоздалая версия два'}));const html=await settle();
        expect(html).toContain('Свежая версия три');expect(html).not.toContain('Запоздалая версия два');
    });
    it('A late action revision 2 cannot replace detail revision 3 already visible',async()=>{
        render();await settle();const oldSaved=ui.actionSaved!;
        vi.mocked(catalogRequestsApi.get).mockResolvedValueOnce(requestDetail({revision:3,title:'Свежая версия три'}));
        ui.buttons.get('Обновить заявку')!();await settle();oldSaved(requestDetail({revision:2,title:'Запоздалая версия два'}));const html=render();
        expect(html).toContain('Свежая версия три');expect(html).not.toContain('Запоздалая версия два');
    });
    it.each([403,404])('An action receipt cannot restore private data after authoritative GET %s',async status=>{
        render();await settle();const oldSaved=ui.actionSaved!;
        vi.mocked(catalogRequestsApi.get).mockRejectedValueOnce({isAxiosError:true,response:{status}});
        ui.buttons.get('Обновить заявку')!();await settle();oldSaved(requestDetail({revision:2,title:'Закрытые данные'}));const html=render();
        expect(html).not.toContain('Закрытые данные');expect(html).not.toContain('Новый MCP');expect(html).not.toContain('История заявки');
    });
});
