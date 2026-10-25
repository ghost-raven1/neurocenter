import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ModelCatalog} from '../src/features/ModelCatalog/ModelCatalog';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
import type {ICatalogModel,IModelCatalog,IModelCreate} from '../src/features/ModelCatalog/types';

const hooks=vi.hoisted(()=>{let cursor=0;const slots:unknown[]=[];return{begin:()=>{cursor=0;},reset:()=>{slots.length=0;},
    state<T>(initial:T){const index=cursor++;if(index>=slots.length)slots[index]=initial;return[slots[index],(value:T)=>{slots[index]=value;}];},
    ref<T>(initial:T){const index=cursor++;return slots[index]??={current:initial};},
};});
interface Button {children?:ReactNode;disabled?:boolean;onClick?:()=>void}
const ui=vi.hoisted(()=>({buttons:new Map<string,Button>(),owner:'admin-a',flags:{model_catalog:true,model_hosting:true},
    catalog:{items:[],assignedModelIds:[]} as IModelCatalog,refresh:vi.fn(),values:{} as IModelCreate,initial:undefined as IModelCreate|undefined,
    finish:undefined as ((values:IModelCreate)=>void)|undefined,connection:undefined as ICatalogModel|undefined,
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state,useRef:hooks.ref}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner;return{scope:owner,captureOwner:()=>()=>owner===ui.owner};}}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({
    useFeatureAvailability:(...keys:Array<keyof typeof ui.flags>)=>({enabled:keys.every(key=>ui.flags[key])}),
    FeatureButton:({features,...props}:Button&{features:Array<keyof typeof ui.flags>})=>{const enabled=features.every(key=>ui.flags[key]);ui.buttons.set(String(props.children),{...props,disabled:props.disabled||!enabled,onClick:()=>{if(enabled&&!props.disabled)props.onClick?.();}});return createElement('button',{disabled:props.disabled||!enabled},props.children);},
}));
vi.mock('../src/features/ModelCatalog/useModelCatalog',()=>({useModelCatalog:()=>({catalog:ui.catalog,loading:false,error:'',refresh:ui.refresh})}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{create:vi.fn(),update:vi.fn(),assign:vi.fn(),unassign:vi.fn()}}));
vi.mock('../src/features/ProjectEmbedding/useProjectReindex',()=>({useProjectReindex:()=>({request:vi.fn(),pending:false,busy:false})}));
vi.mock('../src/features/ProjectEmbedding/ProjectReindexStatus',()=>({ProjectReindexStatus:()=>null}));
vi.mock('../src/features/ProjectEmbedding/EmbeddingTarget',()=>({useEmbeddingTarget:()=>({blocked:false}),EmbeddingTargetFields:()=>null}));
vi.mock('../src/features/ModelCatalog/ModelCard',()=>({ModelCard:()=>null}));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal',()=>({RemoteConnectionModal:({model}:{model:ICatalogModel})=>{ui.connection=model;return createElement('div',null,'API connection: '+model.model);}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children,input=()=>null;
    const Form=Object.assign(({children,onFinish,initialValues}:{children?:ReactNode;onFinish:typeof ui.finish;initialValues:IModelCreate})=>{
        ui.finish=onFinish;ui.initial=initialValues;return children;
    },{Item:content,useForm:()=>[{}],useWatch:(name:keyof IModelCreate)=>ui.values[name]});
    return{Form,Tooltip:content,Modal:({children,footer}:{children?:ReactNode;footer?:ReactNode})=>createElement('section',null,children,footer),Space:content,Row:content,Col:content,Spin:input,Empty:content,
        Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),Typography:{Title:content,Text:content,Paragraph:content},
        Input:Object.assign(input,{TextArea:input,Search:input}),InputNumber:input,Select:input,Checkbox:content,
        Button:(props:Button)=>{ui.buttons.set(String(props.children),props);return createElement('button',{disabled:props.disabled},props.children);}};
});
const created:ICatalogModel={id:'api-one',name:'API команды',description:'',runtime:'remote-openai',capability:'chat',model:'manual/model:alias',modelVersion:'2026-10',dimension:null,manifestSha256:null,revision:1,source:'custom',createdAt:'',updatedAt:''};
const input:IModelCreate={name:created.name,description:'',runtime:'remote-openai',capability:'chat',model:created.model,modelVersion:created.modelVersion};
function render(isMain=true){hooks.begin();ui.buttons.clear();ui.connection=undefined;return renderToStaticMarkup(createElement(ModelCatalog,{projectId:'project-one',embedded:true,canManage:true,isMain}));}
function open(label='Подключить API'){render();expect(ui.buttons.has(label)).toBe(true);ui.buttons.get(label)!.onClick!();return render();}
async function flush(){for(let i=0;i<16;i++)await Promise.resolve();}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
beforeEach(()=>{vi.clearAllMocks();hooks.reset();ui.owner='admin-a';ui.flags={model_catalog:true,model_hosting:true};ui.catalog={items:[],assignedModelIds:[]};ui.values={} as IModelCreate;ui.initial=undefined;ui.finish=undefined;ui.connection=undefined;
    vi.mocked(modelCatalogApi.create).mockResolvedValue(created);ui.refresh.mockImplementation(async()=>{ui.catalog={items:[created],assignedModelIds:[]};});});

describe('Прямой вход подключения внешнего API',()=>{
    it('Главный администратор открывает OpenAI-compatible chat с общим scope; обычное добавление остаётся embedding',()=>{
        const html=open();expect(ui.initial).toMatchObject({runtime:'remote-openai',capability:'chat'});expect(html).toContain('Подключение доступно команде');expect(html).toContain('добавление в проект — отдельно');
        expect(modelCatalogApi.create).not.toHaveBeenCalled();expect(modelCatalogApi.assign).not.toHaveBeenCalled();
    });
    it('Обычная кнопка добавления сохраняет embedding default',()=>{open('Добавить модель');expect(ui.initial).toMatchObject({runtime:'remote-openai',capability:'embedding'});});
    it('Сохранённая ручная модель открывает существующее API-подключение без автоматического назначения проекту',async()=>{
        open();ui.values={...input};ui.finish!(ui.values);await flush();expect(render()).toContain('API connection: manual/model:alias');
        expect(ui.connection).toEqual(created);expect(modelCatalogApi.create).toHaveBeenCalledExactlyOnceWith(input,expect.any(String));expect(ui.refresh).toHaveBeenCalledOnce();expect(modelCatalogApi.assign).not.toHaveBeenCalled();
    });
    it('Потерянный ответ создания оставляет ручной ID и повторяет тот же draft request key',async()=>{
        vi.mocked(modelCatalogApi.create).mockRejectedValueOnce(Error('Ответ создания потерян'));open();ui.values={...input};ui.finish!(ui.values);await flush();
        expect(render()).toContain('Ответ создания потерян');expect(ui.values.model).toBe(input.model);expect(ui.connection).toBeUndefined();ui.finish!(ui.values);await flush();render();
        expect(modelCatalogApi.create).toHaveBeenCalledTimes(2);expect(vi.mocked(modelCatalogApi.create).mock.calls[1]).toEqual(vi.mocked(modelCatalogApi.create).mock.calls[0]);expect(ui.connection?.id).toBe(created.id);expect(ui.refresh).toHaveBeenCalledOnce();
    });
    it('Поздний ответ прежнего владельца не открывает секретную настройку и не перечитывает новый каталог',async()=>{
        const pending=deferred<ICatalogModel>();vi.mocked(modelCatalogApi.create).mockReturnValueOnce(pending.promise);open();ui.values={...input};ui.finish!(ui.values);ui.owner='admin-b';pending.resolve(created);await flush();render();
        expect(ui.connection).toBeUndefined();expect(ui.refresh).not.toHaveBeenCalled();expect(modelCatalogApi.assign).not.toHaveBeenCalled();
    });
    it('Вход доступен только главному администратору и model_catalog; выключенный флаг блокирует и прямую отправку',()=>{
        expect(render(false)).not.toContain('Подключить API');ui.flags.model_catalog=false;render();expect(ui.buttons.get('Подключить API')?.disabled).toBe(true);ui.buttons.get('Подключить API')?.onClick?.();expect(render()).not.toContain('Шаг 1 из 2');
        ui.flags.model_catalog=true;open();ui.values={...input};ui.flags.model_catalog=false;render();ui.finish!(ui.values);expect(modelCatalogApi.create).not.toHaveBeenCalled();
    });
});
