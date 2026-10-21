import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {RequestFormModal} from '../src/features/CatalogRequests/RequestFormModal';
import {catalogRequestsApi} from '../src/features/CatalogRequests/api';
import {pendingCreationKey,readPendingCreation} from '../src/features/CatalogRequests/pendingCreation';
import {catalogRequest,requestInput} from './catalog-request-fixtures';

const ui=vi.hoisted(()=>({cursor:0,slots:[] as Array<{value?:unknown;deps?:unknown[]}>,effects:[] as Array<()=>void>,owner:'author',epoch:0,initialized:false,
    values:{} as Record<string,unknown>,finish:undefined as ((value:Record<string,unknown>)=>void)|undefined,change:undefined as (()=>void)|undefined,buttons:new Map<string,{click?:()=>void;disabled?:boolean}>(),resets:0,
    fields:[] as Array<Record<string,unknown>>,form:{
        setFieldsValue:(value:Record<string,unknown>)=>{Object.assign(ui.values,value);ui.fields.push(value);},
        getFieldsValue:()=>ui.values,resetFields:()=>{ui.resets++;},submit:()=>ui.finish?.(ui.values),
    },
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
    useState:(initial:unknown)=>{const index=ui.cursor++;const slot=ui.slots[index]??={value:typeof initial==='function'?initial():initial};return[slot.value,(value:unknown)=>{slot.value=typeof value==='function'?(value as (old:unknown)=>unknown)(slot.value):value;}];},
    useRef:(initial:unknown)=>{const index=ui.cursor++;return(ui.slots[index]??={value:{current:initial}}).value;},
    useEffect:(effect:()=>void,deps:unknown[])=>{const index=ui.cursor++,previous=ui.slots[index];if(previous?.deps?.length===deps.length&&deps.every((value,n)=>Object.is(value,previous.deps![n])))return;ui.slots[index]={deps};ui.effects.push(effect);},
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner,epoch=ui.epoch;return{scope:owner,captureOwner:()=>()=>owner===ui.owner&&epoch===ui.epoch};}}));
vi.mock('../src/features/CatalogRequests/RequestTargetPicker',()=>({RequestTargetPicker:()=>null}));
vi.mock('../src/features/CatalogRequests/api',()=>({catalogRequestsApi:{create:vi.fn(),edit:vi.fn()}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    const Form=Object.assign(({children,onFinish,onValuesChange,initialValues}:{children?:ReactNode;onFinish:typeof ui.finish;onValuesChange:()=>void;initialValues:Record<string,unknown>})=>{ui.finish=onFinish;ui.change=onValuesChange;if(!ui.initialized){ui.initialized=true;ui.values={...initialValues};}return children;},{useForm:()=>[ui.form],useWatch:(key:string)=>ui.values[key],Item:content});
    return {Form,Input:Object.assign(()=>null,{TextArea:()=>null}),Modal:content,Select:()=>null,Space:content,Typography:{Paragraph:content},Alert:({message,description,action}:{message:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',null,message,description,action),Button:({children,onClick,disabled}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean})=>{ui.buttons.set(String(children),{click:onClick,disabled});return children;}};
});
const records=new Map<string,string>(),onClose=vi.fn(),onSaved=vi.fn();let deniedWrite=false;
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function render(request?:ReturnType<typeof catalogRequest>,context:{assetType?:'plugin'|'model';projectId?:string}={}){ui.cursor=0;ui.buttons.clear();const html=renderToStaticMarkup(createElement(RequestFormModal,{open:true,projects:[],request,onClose,onSaved,...context}));ui.effects.splice(0).forEach(effect=>effect());return html;}
function resetInstance(){ui.cursor=0;ui.slots=[];ui.effects=[];ui.initialized=false;ui.values={};ui.buttons.clear();ui.fields=[];}
function fill(changes:Record<string,unknown>={}){ui.values={...requestInput(),targetId:undefined,...changes};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
beforeEach(()=>{vi.clearAllMocks();resetInstance();ui.owner='author';ui.epoch=0;ui.resets=0;records.clear();deniedWrite=false;
    vi.stubGlobal('sessionStorage',{getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{if(deniedWrite)throw Error('QuotaExceededError');records.set(key,value);},removeItem:(key:string)=>records.delete(key)});
    vi.mocked(catalogRequestsApi.create).mockResolvedValue(catalogRequest() as never);vi.mocked(catalogRequestsApi.edit).mockResolvedValue(catalogRequest({revision:2}) as never);
});
afterEach(()=>vi.unstubAllGlobals());

describe('Явная подача и восстановление заявки',()=>{
    it('Pristine defaults follow tool/model and project context instead of hidden initialValues',()=>{
        render();expect(ui.values.assetType).toBe('plugin');render(undefined,{assetType:'model',projectId:'prj-next'});
        expect(ui.values).toMatchObject({assetType:'model',projectId:'prj-next'});
    });
    it('A real user draft keeps its kind, project and text when catalog context changes',()=>{
        render();fill({assetType:'mcp',projectId:'prj-original',description:'МОЙ ЧЕРНОВИК'});ui.change!();render(undefined,{assetType:'model',projectId:'prj-next'});
        expect(ui.values).toMatchObject({assetType:'mcp',projectId:'prj-original',description:'МОЙ ЧЕРНОВИК'});
    });
    it('Double submit creates one durable intent before POST and closes only on confirmed receipt',async()=>{
        const pending=deferred<ReturnType<typeof catalogRequest>>();vi.mocked(catalogRequestsApi.create).mockReturnValue(pending.promise as never);render();fill();ui.finish!(ui.values);ui.finish!(ui.values);await flush();
        expect(catalogRequestsApi.create).toHaveBeenCalledOnce();expect(onSaved).not.toHaveBeenCalled();const key=vi.mocked(catalogRequestsApi.create).mock.calls[0][1];expect(readPendingCreation('author')?.key).toBe(key);
        pending.resolve(catalogRequest());await flush();expect(onSaved).toHaveBeenCalledOnce();expect(readPendingCreation('author')).toBeNull();
    });
    it('Lost ACK freezes changed fields; retry sends the identical original payload and key',async()=>{
        vi.mocked(catalogRequestsApi.create).mockRejectedValueOnce(new Error('Lost ACK'));render();fill();ui.finish!(ui.values);await flush();const original=vi.mocked(catalogRequestsApi.create).mock.calls[0];
        const html=render();expect(html).toContain('Подтверждение не получено');expect(ui.buttons.get('Проверить / повторить предыдущую отправку')?.disabled).toBe(false);
        fill({title:'НЕ ОТПРАВЛЯТЬ'});ui.buttons.get('Проверить / повторить предыдущую отправку')!.click!();await flush();expect(vi.mocked(catalogRequestsApi.create).mock.calls[1]).toEqual(original);
    });
    it('A new CTA instance / reload restores only data, never auto-POSTs; an explicit retry reconciles the receipt',async()=>{
        vi.mocked(catalogRequestsApi.create).mockRejectedValueOnce(new Error('Lost ACK'));render();fill();ui.finish!(ui.values);await flush();const original=vi.mocked(catalogRequestsApi.create).mock.calls[0];
        resetInstance();render();const html=render();expect(catalogRequestsApi.create).toHaveBeenCalledOnce();expect(ui.values.title).toBe(original[0].title);expect(html).toContain('Подтверждение не получено');
        ui.buttons.get('Проверить / повторить предыдущую отправку')!.click!();await flush();expect(vi.mocked(catalogRequestsApi.create).mock.calls[1]).toEqual(original);expect(readPendingCreation('author')).toBeNull();
    });
    it('Another access scope never sees the pending private text; late old receipt cannot close its new form',async()=>{
        const pending=deferred<ReturnType<typeof catalogRequest>>();vi.mocked(catalogRequestsApi.create).mockReturnValueOnce(pending.promise as never);render();fill({description:'PRIVATE_OLD'});ui.finish!(ui.values);await flush();
        ui.owner='other';ui.epoch++;resetInstance();render();expect(ui.values.description).not.toBe('PRIVATE_OLD');pending.resolve(catalogRequest());await flush();expect(onSaved).not.toHaveBeenCalled();expect(records.has(pendingCreationKey('author'))).toBe(true);
    });
    it('Quota failure prevents POST; enabling storage and explicit recovery permits a later submission',async()=>{
        deniedWrite=true;render();fill();ui.finish!(ui.values);await flush();expect(catalogRequestsApi.create).not.toHaveBeenCalled();expect(render()).toContain('Новая отправка приостановлена');
        deniedWrite=false;ui.buttons.get('Повторить проверку отправки')!.click!();render();render();ui.finish!(ui.values);await flush();expect(catalogRequestsApi.create).toHaveBeenCalledOnce();
    });
    it('Damaged saved intent cannot be overwritten or silently replaced by another request',async()=>{
        const raw='{"schemaVersion":99}';records.set(pendingCreationKey('author'),raw);render();render();fill();ui.finish!(ui.values);await flush();expect(catalogRequestsApi.create).not.toHaveBeenCalled();expect(records.get(pendingCreationKey('author'))).toBe(raw);expect(render()).toContain('повреждена');
    });
    it('A definite400 keeps the draft editable and permits corrected input with a new key',async()=>{
        vi.mocked(catalogRequestsApi.create).mockRejectedValueOnce({isAxiosError:true,response:{status:400,data:{message:'Исправьте данные'}}});render();fill();ui.finish!(ui.values);await flush();const first=vi.mocked(catalogRequestsApi.create).mock.calls[0][1];expect(readPendingCreation('author')).toBeNull();
        expect(render()).toContain('Исправьте данные');fill({title:'Исправлено'});ui.finish!(ui.values);await flush();expect(vi.mocked(catalogRequestsApi.create).mock.calls[1][1]).not.toBe(first);
    });
    it('403 clears private form fields and does not pretend that submission succeeded',async()=>{
        vi.mocked(catalogRequestsApi.create).mockRejectedValueOnce({isAxiosError:true,response:{status:403}});render();fill();ui.finish!(ui.values);await flush();expect(onSaved).not.toHaveBeenCalled();expect(onClose).toHaveBeenCalledOnce();expect(ui.resets).toBe(1);expect(readPendingCreation('author')).toBeNull();
    });
    it('Owner edit409 keeps draft and expected revision; never silently rebases a newer version',async()=>{
        vi.mocked(catalogRequestsApi.edit).mockRejectedValueOnce({isAxiosError:true,response:{status:409,data:{message:'Заявка изменилась'}}});const original=catalogRequest();render(original);fill({description:'МОЙ ТЕКСТ'});ui.finish!(ui.values);await flush();
        expect(render(original)).toContain('Заявка изменилась');expect(ui.resets).toBe(0);expect(ui.values.description).toBe('МОЙ ТЕКСТ');expect(vi.mocked(catalogRequestsApi.edit).mock.calls[0][2]).toBe(1);expect(onClose).not.toHaveBeenCalled();
    });
});
