import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredSetup, flushSetup} from './admin-setup-hooks.fixture';
import {modalAntd, uiNode} from './modal-actions.fixture';
import {detail, model} from './model-chat-fixtures';
import type {IModelChatConversation, IModelChatDetail} from '../src/features/ModelChat/types';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';
import type {IProjectSummary} from '../src/core/api/interfaces';
type Workspace = Parameters<typeof import('../src/features/ModelChat/ChatWorkspace').ChatWorkspace>[0];
type List = Parameters<typeof import('../src/features/ModelChat/ConversationList').ConversationList>[0];
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture'), {modalUi} = await import('./modal-actions.fixture');
    const parent = adminSetupHooks(), child = adminSetupHooks(), owner = {value: 'alice', active: true};
    return {parent, child, active: parent, childKey: undefined as string | null | undefined, ui: modalUi(), owner,
        user: {activeRole: 'Главный админ', userRoles: ['Главный админ'], projectRoles: [] as Array<{projectId: string; projectName: string; role: string}>},
        projects: [] as IProjectSummary[], ready: true, projectsLoading: false, projectsError: '', projectsRefresh: vi.fn(),
        models: [] as ICatalogModel[], assigned: [] as string[], modelsKnown: true, modelsLoading: false, modelsError: '', modelsRefresh: vi.fn(),
        items: [] as IModelChatConversation[], indexLoading: false, indexError: '', indexRefresh: vi.fn(), changed: vi.fn(),
        workspace: undefined as Workspace | undefined, list: undefined as List | undefined, close: vi.fn(), push: vi.fn(),
        capture: () => { const key = owner.value; return () => owner.active && owner.value === key; }};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: (initial: unknown) => h.active.state(initial), useRef: (initial: unknown) => h.active.ref(initial), useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => h.active.effect(effect, deps)}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: h.user}})}));
vi.mock('react-router-dom', () => ({useHistory: () => ({push: h.push})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.owner.value, captureOwner: h.capture})}));
vi.mock('../src/modules/Projects/useAvailableProjects', () => ({useAvailableProjects: () => ({projects: h.projects, ready: h.ready, loading: h.projectsLoading, error: h.projectsError, refresh: h.projectsRefresh})}));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({useModelCatalog: () => ({catalog: h.modelsKnown ? {items: h.models, assignedModelIds: h.assigned} : null, loading: h.modelsLoading, error: h.modelsError, refresh: h.modelsRefresh})}));
vi.mock('../src/features/ModelChat/useChatIndex', () => ({useChatIndex: () => ({items: h.items, loading: h.indexLoading, error: h.indexError, refresh: h.indexRefresh, changed: h.changed})}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {read: vi.fn()}}));
vi.mock('../src/features/ModelCatalog/api', () => ({modelCatalogApi: {get: vi.fn()}}));
vi.mock('../src/features/ModelChat/ChatWorkspace', () => ({ChatWorkspace: (props: Workspace) => { h.workspace = props; return createElement('main', null, props.navigation?.controls(action => action())); }}));
vi.mock('../src/features/ModelChat/ConversationList', () => ({ConversationList: (props: List) => { h.list = props; return null; }}));
vi.mock('antd', async () => modalAntd(h.ui, (await import('react')).createElement));
import ChatOverlay from '../src/features/ModelChat/ChatOverlay';
import {modelChatApi} from '../src/features/ModelChat/api';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
let props: Parameters<typeof ChatOverlay>[0];
/** Parent alias resolution and keyed private scopes commit separately, as React mounts them. */
const render = () => {
    h.ui.nodes = []; h.workspace = undefined; h.list = undefined; h.active = h.parent; h.parent.begin(); const tree = ChatOverlay(props) as ReactElement<Record<string, unknown>>; h.parent.commit();
    if ('onProject' in tree.props) {
        if (h.childKey !== tree.key) { h.child.dispose(); h.childKey = tree.key; }
        h.active = h.child; h.child.begin(); const html = renderToStaticMarkup(tree); h.child.commit(); return html;
    }
    h.child.dispose(); h.childKey = undefined; return renderToStaticMarkup(tree);
};
const select = (label: string) => h.ui.nodes.find(node => node.kind === 'Select' && node.props['aria-label'] === label)!.props;
const button = (label: string) => uiNode(h.ui, 'Button', label);
const conversation = (id = 'chat-1', modelId = model.id) => ({...detail().conversation, id, modelId});
const open = async (value = conversation()) => { h.items = [value]; render(); h.list!.onSelect(value.id); await flushSetup(); return render(); };
beforeEach(() => {
    h.parent.dispose(); h.child.dispose(); vi.resetAllMocks(); h.active = h.parent; h.childKey = undefined; h.owner.value = 'alice'; h.owner.active = true;
    h.user = {activeRole: 'Главный админ', userRoles: ['Главный админ'], projectRoles: []}; h.projects = [{id: 'prj-one', name: 'Alpha'}, {id: 'prj-two', name: 'Beta'}] as IProjectSummary[]; h.ready = true; h.projectsLoading = false; h.projectsError = '';
    h.models = [model, {...model, id: 'other-model', name: 'Другая модель'}]; h.assigned = h.models.map(value => value.id); h.modelsKnown = true; h.modelsLoading = false; h.modelsError = ''; h.items = []; h.indexLoading = false; h.indexError = '';
    props = {projectId: 'prj-one', onClose: h.close}; vi.mocked(modelChatApi.read).mockResolvedValue(detail()); vi.mocked(modelCatalogApi.get).mockImplementation(async id => h.models.find(value => value.id === id) ?? {...model, id});
});
afterEach(() => { h.parent.dispose(); h.child.dispose(); });

describe('Header overlay: project/model selection and keyed private lifecycle', () => {
    it('project preflight error offers a real retry and close, alias canonicalization precedes the keyed scope', () => {
        props.projectId = 'Alpha'; h.ready = false; h.projectsError = 'Проекты недоступны'; expect(render()).toContain('Проекты недоступны'); button('Повторить').onClick(); expect(h.projectsRefresh).toHaveBeenCalledOnce(); uiNode(h.ui, 'Modal').onCancel(); expect(h.close).toHaveBeenCalledOnce(); expect(h.list).toBeUndefined();
        h.projectsError = ''; expect(render()).not.toContain('Выберите модель'); h.ready = true; render(); render(); expect(select('Проект чата').value).toBe('prj-one'); select('Модель чата').onChange(model.id); render(); const key = h.childKey; h.projects = [{id: 'prj-one', name: 'Renamed'}] as IProjectSummary[]; render(); expect(h.childKey).toBe(key); expect(h.workspace?.model.id).toBe(model.id); expect(h.workspace?.projectName).toBe('Renamed');
    });
    it('project changes mount a fresh scope, common admin model choice stays explicit and connect closes before routing', () => {
        render(); select('Модель чата').onChange(model.id); render(); expect(h.workspace).toBeDefined(); select('Проект чата').onChange('prj-two'); render(); expect(h.workspace).toBeUndefined(); expect(select('Проект чата').value).toBe('prj-two');
        button('Подключить модель').onClick(); expect(h.close).toHaveBeenCalledOnce(); expect(h.push).toHaveBeenLastCalledWith('/store?tab=models&p=prj-two'); expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.push.mock.invocationCallOrder[0]);
        select('Проект чата').onChange(''); render(); expect(select('Проект чата').value).toBe(''); expect(h.list!.onNewGroup).toBeUndefined(); button('Подключить модель').onClick(); expect(h.push).toHaveBeenLastCalledWith('/store?tab=models');
    });
    it('project selector lists only effective developer grants and retains an honest unavailable current-project label', () => {
        h.user = {activeRole: 'Разработчик', userRoles: ['Разработчик'], projectRoles: [{projectId: 'prj-one', projectName: 'Alpha', role: 'Разработчик'}, {projectId: 'prj-two', projectName: 'Beta', role: 'Наблюдатель'}]}; render(); expect(select('Проект чата').options).toEqual([{value: '', label: 'Выберите проект', disabled: true}, {value: 'prj-one', label: 'Alpha'}]);
        h.projects = []; render(); expect(select('Проект чата').options).toContainEqual({value: 'prj-one', label: 'Текущий проект'}); h.user.projectRoles = []; expect(render()).toContain('Выберите проект с доступом'); expect(select('Модель чата').disabled).toBe(true);
    });
    it('loading/error and non-ready/unassigned models cannot select a default; retry only refreshes metadata', () => {
        h.modelsLoading = true; expect(render()).toContain('Загружаем модели'); select('Модель чата').onChange(model.id); render(); expect(h.workspace).toBeUndefined(); h.modelsLoading = false; h.modelsError = 'Модели недоступны'; render(); select('Модель чата').onChange(model.id); render(); expect(h.workspace).toBeUndefined(); button('Повторить').onClick(); expect(h.modelsRefresh).toHaveBeenCalledOnce();
        h.modelsError = ''; h.assigned = []; h.models = [{...model, capability: 'embedding'}, {...model, verificationSha256: null}]; expect(render()).toContain('нет готовой модели'); expect(select('Модель чата').options).toEqual([]); select('Модель чата').onChange('missing'); render(); expect(h.workspace).toBeUndefined(); expect(modelChatApi.read).not.toHaveBeenCalled();
    });
    it('unknown metadata never invents models; a saved common conversation resolves its own model without a project', async () => {
        props.projectId = undefined; h.modelsKnown = false; h.modelsLoading = true; render(); expect(select('Модель чата').options).toEqual([]); expect(h.workspace).toBeUndefined();
        h.modelsKnown = true; h.modelsLoading = false; h.models = []; h.assigned = []; const saved = {...conversation(), projectId: null}; vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({conversation: saved})); await open(saved); expect(h.workspace?.navigation?.initialDetail?.conversation.projectId).toBeNull(); expect(h.workspace?.model.id).toBe(model.id); expect(h.workspace?.projectId).toBeUndefined();
    });
    it('new group/new model/new dialogue intents are explicit, and saved groups keep their own model/history', async () => {
        render(); h.list!.onNewGroup!(); expect(render()).toContain('Выберите базовую модель'); h.list!.onNew(); expect(render()).toContain('Выберите модель для нового'); h.list!.onNewGroup!(); render(); select('Модель чата').onChange('other-model'); render(); expect(h.workspace?.navigation?.initialGroup).toBe(true); expect(h.workspace?.model.id).toBe('other-model'); expect(h.workspace?.navigation?.initialDetail).toBeUndefined();
        const saved = detail({conversation: {...conversation('saved', model.id), mode: 'group'}, turns: []}); vi.mocked(modelChatApi.read).mockResolvedValueOnce(saved); h.workspace!.navigation!.onSelect(saved.conversation); await flushSetup(); render(); expect(h.workspace?.navigation?.initialDetail).toEqual(saved); expect(h.workspace?.navigation?.initialGroup).toBeUndefined(); expect(h.workspace?.model.id).toBe(model.id); h.workspace!.navigation!.onRefresh(); expect(h.indexRefresh).toHaveBeenCalledOnce(); expect(h.workspace!.navigation!.onChanged).toBe(h.changed);
    });
    it('missing saved IDs do no read; opening freezes controls until both conversation and exact model resolve', async () => {
        render(); h.list!.onSelect('missing'); expect(modelChatApi.read).not.toHaveBeenCalled(); const pending = deferredSetup<IModelChatDetail>(), found = deferredSetup<ICatalogModel>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(pending.promise); vi.mocked(modelCatalogApi.get).mockReturnValueOnce(found.promise); h.items = [conversation()]; render(); h.list!.onSelect('chat-1'); expect(render()).toContain('Открываем диалог'); expect(select('Проект чата').disabled).toBe(true); expect(select('Модель чата').disabled).toBe(true); expect(h.list!.disabled).toBe(true);
        pending.resolve(detail()); await flushSetup(); render(); expect(h.workspace).toBeUndefined(); found.resolve(model); await flushSetup(); render(); expect(h.workspace?.navigation?.initialDetail?.conversation.id).toBe('chat-1');
    });
    it.each(['project', 'model'] as const)('a mismatched saved %s refuses cross-scope history and displays the exact recovery reason', async mismatch => {
        vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({conversation: {...conversation(), ...(mismatch === 'project' ? {projectId: 'private-project'} : {modelId: 'wrong-model'})}})); const html = await open(); expect(html).toContain('Диалог относится к другому проекту'); expect(h.workspace).toBeUndefined();
    });
    it.each(['resolve', 'reject'] as const)('a newer conversation opening aborts the old %s and retains only the latest selection', async outcome => {
        const old = deferredSetup<IModelChatDetail>(), current = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); h.items = [conversation('old'), conversation('current')]; render(); h.list!.onSelect('old'); const signal = vi.mocked(modelChatApi.read).mock.calls[0][1]; render(); h.list!.onSelect('current'); expect(signal.aborted).toBe(true);
        if (outcome === 'resolve') old.resolve(detail({conversation: conversation('old')})); else old.reject(Error('PRIVATE OLD ERROR')); await flushSetup(); expect(render()).not.toContain('PRIVATE OLD'); current.resolve(detail({conversation: conversation('current')})); await flushSetup(); render(); expect(h.workspace?.navigation?.initialDetail?.conversation.id).toBe('current');
    });
    it.each(['resolve', 'reject'] as const)('owner switch remounts its private scope and aborts the former owner late %s', async outcome => {
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(pending.promise); h.items = [conversation()]; render(); h.list!.onSelect('chat-1'); const signal = vi.mocked(modelChatApi.read).mock.calls[0][1]; h.owner.value = 'bob'; h.items = []; render(); expect(signal.aborted).toBe(true);
        if (outcome === 'resolve') pending.resolve(detail()); else pending.reject(Error('PRIVATE OLD OWNER')); await flushSetup(); expect(render()).not.toContain('PRIVATE OLD OWNER'); expect(h.workspace).toBeUndefined();
    });
    it('opening failure leaves existing history selected; close aborts the new read before returning to the launcher', async () => {
        await open(); const selected = h.workspace?.navigation?.initialDetail; vi.mocked(modelCatalogApi.get).mockRejectedValueOnce(Error('Модель больше недоступна')); h.workspace!.navigation!.onSelect(conversation('second')); await flushSetup(); expect(render()).toContain('Модель больше недоступна'); expect(h.workspace?.navigation?.initialDetail).toEqual(selected);
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(pending.promise); h.workspace!.navigation!.onSelect(conversation('third')); render(); const signal = vi.mocked(modelChatApi.read).mock.calls.at(-1)![1]; h.workspace!.onClose(); expect(signal.aborted).toBe(true); expect(h.close).toHaveBeenCalledOnce(); pending.resolve(detail({conversation: conversation('third')})); await flushSetup(); render(); expect(h.workspace?.navigation?.initialDetail).toEqual(selected);
    });
    it('welcome close and unmount abort their reads; existing index errors remain visible and refreshable', async () => {
        h.indexError = 'Список временно недоступен'; expect(render()).toContain('Список временно недоступен'); h.list!.onRefresh(); expect(h.indexRefresh).toHaveBeenCalledOnce();
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(pending.promise); h.items = [conversation()]; render(); h.list!.onSelect('chat-1'); render(); const signal = vi.mocked(modelChatApi.read).mock.calls[0][1]; uiNode(h.ui, 'Modal').onCancel(); expect(signal.aborted).toBe(true); expect(h.close).toHaveBeenCalledOnce(); h.child.dispose(); pending.resolve(detail()); await flushSetup(); expect(h.workspace).toBeUndefined();
    });
});
