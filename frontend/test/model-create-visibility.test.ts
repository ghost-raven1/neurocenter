// @vitest-environment jsdom
import './feature-flags-enabled';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import type { IProjectEmbedding } from '../src/features/ProjectEmbedding/model';
import { ModelCatalog } from '../src/features/ModelCatalog/ModelCatalog';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';
import type { ICatalogModel, IModelCatalog, IModelCreate } from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({
    buttons: new Map<string, () => void>(), owners: new Map<string, () => () => boolean>(),
    catalog: null as IModelCatalog | null, nextCatalog: null as IModelCatalog | null, refresh: vi.fn(),
    query: '', changeQuery: undefined as ((event: { target: { value: string } }) => void) | undefined,
    assignedOnly: true, submit: undefined as ((values: IModelCreate) => void) | undefined,
    cards: [] as Array<{ model: ICatalogModel; assigned: boolean; canAssign: boolean; onAssign: () => void;onConnect?:()=>void;connectionUnavailableReason?:string }>,
    reindex: vi.fn(), view: undefined as (() => void) | undefined, edit: undefined as (() => void) | undefined,
    owner:'admin-a',loading:false,loadError:'',reindexPending:false,reindexBusy:false,planState:undefined as string|undefined,targetBlocked:false,runtime:'ollama',
    target:{deviceId:'device-one',assetId:'rag-one',assetKind:'mcp' as const,version:9,expectedManifest:'a'.repeat(64),expectedBindingId:'b'.repeat(64),expectedInstanceId:'11111111-1111-4111-8111-111111111111'},
}));

vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn() } }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    const owner=ui.owner;
    if(!ui.owners.has(owner))ui.owners.set(owner,()=>()=>ui.owner===owner);
    return {scope:owner,captureOwner:ui.owners.get(owner)!};
} }));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({ useModelCatalog: () => ({ catalog: ui.catalog, loading: ui.loading, error: ui.loadError, refresh: ui.refresh }) }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: { create: vi.fn(), update: vi.fn(), assign: vi.fn(),unassign:vi.fn() } }));
vi.mock('../src/features/ProjectEmbedding/useProjectReindex', () => ({useProjectReindex: () => ({request:ui.reindex,pending:ui.reindexPending,busy:ui.reindexBusy,plan:ui.planState?{state:ui.planState}:undefined})}));
vi.mock('../src/features/ProjectEmbedding/ProjectReindexStatus', () => ({ProjectReindexStatus: () => null}));
vi.mock('../src/features/ProjectEmbedding/EmbeddingTarget', () => ({useEmbeddingTarget: () => ({value:ui.target,blocked:ui.targetBlocked,reason:'Выберите компьютер для локального OpenCodeRAG.'}),EmbeddingTargetFields:()=>null}));
vi.mock('../src/features/ModelCatalog/ModelCard', () => ({ ModelCard: (props: typeof ui.cards[number] & { onView: () => void }) => {
    ui.cards=ui.cards.filter(card=>card.model.id!==props.model.id);ui.cards.push(props);ui.view=props.onView;
    return createElement('article', {'aria-label':props.model.name},props.model.name);
} }));
vi.mock('../src/features/ModelCatalog/ModelDetails', () => ({ ModelDetails: ({ onEdit }: { onEdit: () => void }) => { ui.edit = onEdit; return null; } }));
vi.mock('../src/features/Discussions', () => ({CatalogFeedback:()=>null}));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal', () => ({RemoteConnectionModal:()=>null}));
vi.mock('../src/features/ModelCatalog/OpenCodeImportModal', () => ({OpenCodeImportModal:()=>null}));
vi.mock('../src/features/ModelCatalog/DeviceCodexConnectionModal', () => ({DeviceCodexConnectionModal:()=>null}));
vi.mock('../src/features/ModelChat/ModelChatModal', () => ({ModelChatModal:()=>null}));
vi.mock('../src/features/OpenCodeProviders/ProviderSetupModal', () => ({ProviderSetupModal:()=>null}));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const input = () => null;
    const Form = Object.assign(({ children, onFinish }: { children?: ReactNode; onFinish: typeof ui.submit }) => {
        ui.submit = onFinish; return children;
    }, { Item: content, useForm: () => [{}], useWatch: (name:string) => name==='runtime'?ui.runtime:'chat' });
    return {
        Form, Tooltip: content, Modal: ({children,footer}:{children?:ReactNode;footer?:ReactNode})=>createElement('section',null,children,footer), Space: content, Row: content, Col: content, Spin: () => null, Empty: content,
        Alert: ({ message }: { message: string }) => message,
        Typography: { Title: content, Text: content, Paragraph: content },
        Input: Object.assign(input, { TextArea: input, Search: ({ value, onChange }: { value: string; onChange: typeof ui.changeQuery }) => {
            ui.query = value; ui.changeQuery = onChange; return null;
        } }), InputNumber: input, Select: input,
        Checkbox: ({ checked, children }: { checked: boolean; children?: ReactNode }) => { ui.assignedOnly = checked; return children; },
        Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
            if (typeof children === 'string' && onClick) ui.buttons.set(children, onClick); return createElement('button',{onClick},children);
        },
    };
});

const model = (id: string, name: string): ICatalogModel => ({ id, name, description: '', model: 'qwen3:4b', capability: 'chat', runtime: 'ollama',
    manifestSha256: null, dimension: null, source: 'custom', revision: 1, createdAt: '2026-10-19', updatedAt: '2026-10-19' });
const existing = model('model-existing', 'Старый'), created = model('model-new', 'Новый');
const values: IModelCreate = { name: created.name, description: 'Новая модель', capability: 'chat', model: created.model };

let container:HTMLElement,root:Root;
async function render(canManage=true) {
    ui.cards=[];ui.buttons.clear();
    await act(async()=>{root.render(createElement(ModelCatalog,{projectId:'project-one',embedded:true,canManage,isMain:true}));});
    return container.textContent??'';
}
/** The connection hook and click preflight consume the same complete authoritative selection. */
function selection():IProjectEmbedding {
    return {projectId:'project-one',revision:0,expectedDimension:0,model:null,modelPin:null,profile:null,
        activeGeneration:'11111111-1111-4111-8111-111111111111',activeSnapshot:null,dataRevision:0};
}
async function flush() { await act(async()=>{for(let index=0;index<10;index++)await Promise.resolve();}); }
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function search() { await render();await act(async()=>{ui.changeQuery!({target:{value:'Старый'}});});await render(); }
async function create() { await search();await act(async()=>{ui.buttons.get('Добавить модель')!();});await render();await act(async()=>{ui.submit!(values);}); }

beforeEach(() => {
    vi.clearAllMocks();ui.owners.clear(); ui.query = ''; ui.assignedOnly = true; ui.submit = undefined; ui.view = undefined; ui.edit = undefined;
    ui.catalog = { items: [existing], assignedModelIds: [existing.id] };
    ui.nextCatalog = { items: [existing, created], assignedModelIds: [existing.id] };
    ui.refresh.mockImplementation(async () => { ui.catalog = ui.nextCatalog; });
    ui.reindex.mockResolvedValue(undefined);
    ui.owner='admin-a';ui.loading=false;ui.loadError='';ui.reindexPending=false;ui.reindexBusy=false;ui.planState=undefined;ui.targetBlocked=false;ui.runtime='ollama';
    vi.mocked(api.get).mockResolvedValue({data:selection()});
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
});
afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();});

describe('Новая модель видна после сохранения в проектном каталоге', () => {
    it('Создание удалённой модели явно ведёт от карточки к адресу и API-ключу', async () => {
        ui.runtime='remote-openai';await render();await act(async()=>{ui.buttons.get('Добавить модель')!();});const html=await render();
        expect(html).toContain('Шаг 1 из 2 — карточка модели');expect(html).toContain('Далее: подключение API');
    });
    it('Успешное создание снимает фильтры и показывает карточку для явного назначения проекту', async () => {
        const pending = deferred<ICatalogModel>(); vi.mocked(modelCatalogApi.create).mockReturnValueOnce(pending.promise);
        await create(); await render(); expect(ui.query).toBe('Старый'); expect(ui.assignedOnly).toBe(true);
        await act(async()=>{pending.resolve(created);}); await render();
        expect(ui.query).toBe(''); expect(ui.assignedOnly).toBe(false);
        expect(ui.cards).toContainEqual(expect.objectContaining({ model: created, assigned: false, canAssign: true }));
        expect(modelCatalogApi.assign).not.toHaveBeenCalled(); expect(ui.refresh).toHaveBeenCalledOnce();
    });

    it('Ошибка создания сохраняет фильтры, форму и введённые данные без перечитывания каталога', async () => {
        vi.mocked(modelCatalogApi.create).mockRejectedValueOnce(new Error('Модель с таким названием уже есть'));
        await create(); await flush(); const html = await render();
        expect(ui.query).toBe('Старый'); expect(ui.assignedOnly).toBe(true);
        expect(html).toContain('Модель с таким названием уже есть'); expect(html).toContain('Сохранить');
        expect(ui.refresh).not.toHaveBeenCalled(); expect(modelCatalogApi.assign).not.toHaveBeenCalled();
    });

    it('Редактирование существующей модели сохраняет поиск и фильтр проекта', async () => {
        ui.nextCatalog = { items: [existing], assignedModelIds: [existing.id] };
        vi.mocked(modelCatalogApi.update).mockResolvedValueOnce(existing);
        await search();await act(async()=>{ui.view!();});await render();await act(async()=>{ui.edit!();});await render();await act(async()=>{ui.submit!({...values,name:existing.name});});
        await flush(); await render();
        expect(ui.query).toBe('Старый'); expect(ui.assignedOnly).toBe(true); expect(ui.refresh).toHaveBeenCalledOnce();
        expect(modelCatalogApi.create).not.toHaveBeenCalled(); expect(modelCatalogApi.assign).not.toHaveBeenCalled();
    });
});

describe('Подключение готовой embedding-модели одним действием', () => {
    const embedding={...created,capability:'embedding' as const,dimension:1536,manifestSha256:'a'.repeat(64),modelPin:'b'.repeat(64)};
    it('Назначает модель и запускает единый управляемый reindex intent; двойной клик не дублирует запрос',async()=>{
        ui.catalog={items:[embedding],assignedModelIds:[]};ui.nextCatalog={items:[embedding],assignedModelIds:[embedding.id]};
        vi.mocked(modelCatalogApi.assign).mockResolvedValue({ok:true});const pending=deferred<void>();ui.reindex.mockReturnValue(pending.promise);
        await render();await act(async()=>{ui.buttons.get('Показать все модели')?.();});await render();
        await act(async()=>{ui.cards[0].onAssign();ui.cards[0].onAssign();});await flush();
        expect(modelCatalogApi.assign).toHaveBeenCalledOnce();expect(ui.reindex).toHaveBeenCalledExactlyOnceWith(embedding,undefined,ui.target);expect(ui.refresh).not.toHaveBeenCalled();
        await act(async()=>{pending.resolve();});await flush();expect(ui.refresh).toHaveBeenCalledOnce();
    });
    it('Отказ назначения не запускает платную переиндексацию',async()=>{
        ui.catalog={items:[embedding],assignedModelIds:[]};vi.mocked(modelCatalogApi.assign).mockRejectedValue(new Error('Доступ отозван'));
        await render();await act(async()=>{ui.buttons.get('Показать все модели')?.();});await render();await act(async()=>{ui.cards[0].onAssign();});await flush();
        expect(ui.reindex).not.toHaveBeenCalled();expect(await render()).toContain('Доступ отозван');
    });
    it.each(['cancelled','stale'])('Назначенная модель после %s подключается без remove/add и без двойного intent',async state=>{
        ui.catalog={items:[embedding],assignedModelIds:[embedding.id]};ui.planState=state;
        const pending=deferred<void>();ui.reindex.mockReturnValue(pending.promise);await render();
        expect(ui.cards[0].onConnect).toEqual(expect.any(Function));await act(async()=>{ui.cards[0].onConnect!();ui.cards[0].onConnect!();});await flush();
        expect(ui.reindex).toHaveBeenCalledExactlyOnceWith(embedding,undefined,ui.target);expect(api.get).toHaveBeenCalledTimes(2);expect(api.get).toHaveBeenLastCalledWith('/api/projects/project-one/embedding');expect(modelCatalogApi.assign).not.toHaveBeenCalled();expect(modelCatalogApi.unassign).not.toHaveBeenCalled();
        await act(async()=>{pending.resolve();});await flush();expect(ui.refresh).not.toHaveBeenCalled();
    });
    it.each(['needs_input','pending','busy','target','loading','catalog-error','role','selection-pending','selection-error'])('Запрет %s сохраняет assigned и не запускает request даже при прямом вызове callback',async guard=>{
        ui.catalog={items:[embedding],assignedModelIds:[embedding.id]};ui.planState=guard==='needs_input'?'needs_input':undefined;
        ui.reindexPending=guard==='pending';ui.reindexBusy=guard==='busy';ui.targetBlocked=guard==='target';ui.loading=guard==='loading';ui.loadError=guard==='catalog-error'?'Не удалось прочитать каталог':'';
        if(guard==='selection-pending')vi.mocked(api.get).mockReturnValueOnce(deferred<{data:IProjectEmbedding}>().promise);
        if(guard==='selection-error')vi.mocked(api.get).mockRejectedValueOnce(new Error('Выбор модели недоступен'));
        await render(guard!=='role');await act(async()=>{ui.cards[0].onConnect?.();});await flush();
        expect(ui.reindex).not.toHaveBeenCalled();expect(modelCatalogApi.assign).not.toHaveBeenCalled();expect(modelCatalogApi.unassign).not.toHaveBeenCalled();
        if(guard==='target')expect(ui.cards[0].connectionUnavailableReason).toBe('Выберите компьютер для локального OpenCodeRAG.');
    });
    it('Старый owner callback не подключает модель; поздняя ошибка не показывается новому владельцу',async()=>{
        ui.catalog={items:[embedding],assignedModelIds:[embedding.id]};await render();const old=ui.cards[0].onConnect!;
        ui.owner='admin-b';await act(async()=>{old();});await flush();expect(ui.reindex).not.toHaveBeenCalled();
        const pending=deferred<void>();ui.reindex.mockReturnValue(pending.promise);await render();await act(async()=>{ui.cards[0].onConnect!();});ui.owner='admin-c';await act(async()=>{pending.reject(new Error('Ошибка прошлого владельца'));});await flush();
        expect(await render()).not.toContain('Ошибка прошлого владельца');expect(ui.refresh).not.toHaveBeenCalled();expect(modelCatalogApi.assign).not.toHaveBeenCalled();expect(modelCatalogApi.unassign).not.toHaveBeenCalled();
    });
});
