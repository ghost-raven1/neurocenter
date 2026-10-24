import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredSetup, flushSetup} from './admin-setup-hooks.fixture';
import {modalAntd, uiNode} from './modal-actions.fixture';
import {detail, evidence, model, participant, response, turn} from './model-chat-fixtures';
import type {IChatWorkspaceNavigation, IModelChatDetail, IModelChatProps} from '../src/features/ModelChat/types';
import type {IEvaluatedFeatureFlags, TFeatureFlagKey} from '../src/features/FeatureFlags/types';
type Composer = Parameters<typeof import('../src/features/ModelChat/ChatComposer').ChatComposer>[0];
type Messages = Parameters<typeof import('../src/features/ModelChat/ChatMessages').ChatMessages>[0];
type Attachments = Parameters<typeof import('../src/features/ModelChat/ChatAttachments').ChatAttachments>[0];
type Editor = Parameters<typeof import('../src/features/ModelChat/ChatParticipantsEditor').ChatParticipantsEditor>[0];
type Preview = Parameters<typeof import('../src/features/ModelChat/AttachmentPreview').AttachmentPreview>[0];
type List = Parameters<typeof import('../src/features/ModelChat/ConversationList').ConversationList>[0];
type Meter = Parameters<typeof import('../src/features/ModelChat/ChatContextMeter').ChatContextMeter>[0];
type ResearchControls = Parameters<typeof import('../src/features/ModelChat/ChatResearchControls').ChatResearchControls>[0];
type Research = ReturnType<typeof import('../src/features/ModelChat/useChatResearch').useChatResearch>;
type Confirmation = {title: string; content: string; onOk: () => unknown; onCancel: () => void; destroy: ReturnType<typeof vi.fn>};
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture'), {modalUi} = await import('./modal-actions.fixture');
    const owner = {value: 'alice', active: true};
    return {hooks: adminSetupHooks(), ui: modalUi(), owner, disabledFlags: new Set<TFeatureFlagKey>(), known: true, close: vi.fn(), focusTrigger: vi.fn(), server: null as unknown as IModelChatDetail,
        composer: undefined as Composer | undefined, messages: undefined as Messages | undefined, attachments: undefined as Attachments | undefined, editor: undefined as Editor | undefined,
        preview: undefined as Preview | undefined, list: undefined as List | undefined, meter: undefined as Meter | undefined, projectContext: undefined as unknown,
        research: {} as Research, researchControls: undefined as ResearchControls | undefined, confirmations: [] as Confirmation[], changeContext: undefined as undefined | ((action: () => void) => void),
        context: {context: undefined as IModelChatDetail['context'] | undefined, loading: false, error: undefined as string | undefined, rejected: false},
        capture: () => { const key = owner.value; return () => owner.active && owner.value === key; }};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect}));
vi.mock('@ant-design/icons', () => ({DeleteOutlined: () => null, EditOutlined: () => null, MenuOutlined: () => null, MoreOutlined: () => null, PlusOutlined: () => null, TeamOutlined: () => null}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.owner.value, captureOwner: h.capture})}));
vi.mock('../src/features/ModelChat/useChatContext', () => ({useChatContext: () => h.context}));
vi.mock('../src/features/ModelChat/useChatResearch', () => ({useChatResearch: () => h.research}));
vi.mock('../src/features/ModelChat/files', async original => ({...await original<typeof import('../src/features/ModelChat/files')>(), chatFileBase64: vi.fn()}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {list: vi.fn(), read: vi.fn(), create: vi.fn(), send: vi.fn(), retry: vi.fn(), rename: vi.fn(), remove: vi.fn(), history: vi.fn(), participants: vi.fn(), upload: vi.fn(), removeAttachment: vi.fn(), deleteFailed: vi.fn(), complete: vi.fn(), cancel: vi.fn()}}));
vi.mock('../src/features/ModelChat/ChatComposer', () => ({ChatComposer: (props: Composer) => { h.composer = props; return null; }}));
vi.mock('../src/features/ModelChat/ChatMessages', () => ({ChatMessages: (props: Messages) => { h.messages = props; return null; }}));
vi.mock('../src/features/ModelChat/ChatAttachments', () => ({ChatAttachments: (props: Attachments) => { h.attachments = props; return null; }}));
vi.mock('../src/features/ModelChat/ChatParticipantsEditor', () => ({ChatParticipantsEditor: (props: Editor) => { h.editor = props; return null; }}));
vi.mock('../src/features/ModelChat/AttachmentPreview', () => ({AttachmentPreview: (props: Preview) => { h.preview = props; return null; }}));
vi.mock('../src/features/ModelChat/ConversationList', () => ({ConversationList: (props: List) => { h.list = props; return null; }}));
vi.mock('../src/features/ModelChat/ChatContextMeter', () => ({ChatContextMeter: (props: Meter) => { h.meter = props; return null; }}));
vi.mock('../src/features/ModelChat/ChatProjectContext', () => ({ChatProjectContext: ({evidence}: {evidence: unknown}) => { h.projectContext = evidence; return null; }}));
vi.mock('../src/features/ModelChat/ChatResearchControls', () => ({ChatResearchControls: (props: ResearchControls) => {h.researchControls = props; return null;}}));
vi.mock('antd', async () => ({...modalAntd(h.ui, (await import('react')).createElement), Tooltip: ({children}: {children?: ReactNode}) => children,
    Dropdown: (props: Record<string, unknown>) => {const trigger = props.children as {ref?: {current: unknown}}; if (trigger.ref) trigger.ref.current = {focus: h.focusTrigger}; h.ui.nodes.push({kind: 'Dropdown', props, text: ''}); return props.children as ReactNode;},
    Modal: Object.assign((props: Record<string, unknown>) => { h.ui.nodes.push({kind: 'Modal', props, text: typeof props.title === 'string' ? props.title : ''}); return createElement('section', null, props.title as ReactNode, props.children as ReactNode); },
        {confirm: (options: Omit<Confirmation, 'destroy'>) => { const value = {...options, destroy: vi.fn()}; h.confirmations.push(value); return value; }})}));
import {ChatWorkspace} from '../src/features/ModelChat/ChatWorkspace';
import {modelChatApi} from '../src/features/ModelChat/api';
import {chatFileBase64} from '../src/features/ModelChat/files';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys} from '../src/features/FeatureFlags/types';
let props: IModelChatProps & {navigation?: IChatWorkspaceNavigation};
const data = (): IEvaluatedFeatureFlags => ({flags: Object.fromEntries(featureFlagKeys.map(key => [key, !h.disabledFlags.has(key)])),
    configured: Object.fromEntries(featureFlagKeys.map(key => [key, !h.disabledFlags.has(key)])), blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []]))}) as IEvaluatedFeatureFlags;
const render = () => { h.hooks.begin(); h.ui.nodes = []; h.editor = undefined; h.preview = undefined; h.messages = undefined;
    const html = renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, {value: {data: h.known ? data() : null, loading: false, error: null, refresh: async () => undefined}}, createElement(ChatWorkspace, props))); h.hooks.commit(); return html; };
const navigation = (): IChatWorkspaceNavigation => ({items: [], loading: false, controls: change => { h.changeContext = change; return null; }, onSelect: vi.fn(), onRefresh: vi.fn(), onChanged: vi.fn()});
const start = async () => { if (props.navigation) props.navigation.initialDetail = h.server; render(); await flushSetup(); return render(); };
const draft = (value: string) => { h.composer!.onDraft(value); return render(); };
const button = (label: string) => h.ui.nodes.find(node => node.kind === 'Button' && (node.text === label || node.props['aria-label'] === label))!.props;
const action = (key: string) => uiNode(h.ui, 'Dropdown').menu.items.find((item: {key: string}) => item.key === key);
const outer = () => h.ui.nodes.find(node => node.kind === 'Modal' && node.props.title !== 'Название диалога')!.props;
const rename = () => uiNode(h.ui, 'Modal', 'Название диалога');
beforeEach(() => {
    h.hooks.dispose(); vi.resetAllMocks(); vi.useFakeTimers(); h.owner.value = 'alice'; h.owner.active = true; h.known = true; h.disabledFlags.clear(); h.server = detail(); h.confirmations = []; h.changeContext = undefined;
    h.context = {context: detail().context, loading: false, error: undefined, rejected: false}; h.research = {enabled: false, project: true, loading: false, error: '', setEnabled: vi.fn(), setProject: vi.fn(), setExternalId: vi.fn(), reset: vi.fn(() => { h.research.enabled = false; h.research.request = undefined; }), restore: vi.fn(value => { h.research.enabled = !!value; h.research.request = value; }), reload: vi.fn()};
    props = {model, projectId: 'prj-one', projectName: 'Проект', onClose: h.close, navigation: navigation()};
    vi.mocked(modelChatApi.list).mockResolvedValue([]); vi.mocked(modelChatApi.read).mockImplementation(async () => h.server);
    vi.mocked(modelChatApi.create).mockImplementation(async (_model, _project, _signal, ids) => h.server = detail({conversation: {...detail().conversation, id: 'new-chat', mode: ids ? 'group' : 'model'}, ...(ids ? {participants: ids.map(id => participant({agentId: id}))} : {})}));
    vi.mocked(modelChatApi.send).mockImplementation(async (_detail, _model, requestId, prompt) => h.server = detail({turns: [turn({requestId, prompt})]})); vi.mocked(modelChatApi.retry).mockImplementation(async () => h.server = detail({turns: [turn()]}));
    vi.mocked(modelChatApi.rename).mockImplementation(async (_id, _revision, title) => h.server = {...h.server, conversation: {...h.server.conversation, title}}); vi.mocked(modelChatApi.remove).mockResolvedValue(undefined);
    vi.mocked(modelChatApi.participants).mockImplementation(async (_detail, ids) => h.server = {...h.server, conversation: {...h.server.conversation, mode: 'group'}, participants: ids.map(id => participant({agentId: id}))});
    vi.mocked(modelChatApi.deleteFailed).mockImplementation(async () => h.server = {...h.server, turns: []}); vi.mocked(modelChatApi.complete).mockImplementation(async () => h.server = {...h.server, turns: h.server.turns.map(value => ({...value, status: 'done'}))});
    vi.mocked(modelChatApi.cancel).mockImplementation(async () => h.server = {...h.server, turns: h.server.turns.map(value => ({...value, status: 'cancelled'}))});
    vi.mocked(modelChatApi.removeAttachment).mockImplementation(async (_detail, id) => h.server = {...h.server, attachments: h.server.attachments.filter(value => value.id !== id)});
    vi.mocked(chatFileBase64).mockResolvedValue('eA=='); vi.mocked(modelChatApi.upload).mockImplementation(async () => h.server = {...h.server, attachments: [{id: 'file-one', name: 'notes.md', mediaType: 'text/markdown', bytes: 1, textBytes: 1, createdAt: ''}]});
});
afterEach(() => { h.hooks.dispose(); vi.useRealTimers(); });

describe('Workspace actions with the actual chat request/owner locks', () => {
    it('context, research and document panels replace one another without changing the draft or consent', async () => {
        await start(); draft('Вопрос, который нужно сохранить');
        const context = h.meter!, research = h.researchControls!;
        context.onOpenChange!(true); render(); expect(h.meter!.open).toBe(true); expect(h.researchControls!.open).toBe(false);
        research.onOpenChange!(true); context.onOpenChange!(false); render();
        expect(h.meter!.open).toBe(false); expect(h.researchControls!.open).toBe(true); expect(h.composer!.filesOpen).toBe(false);
        h.composer!.onFilesOpenChange!(true); research.onOpenChange!(false); render();
        expect(h.composer!.filesOpen).toBe(true); expect(h.researchControls!.open).toBe(false);
        h.composer!.onFilesOpenChange!(false); render(); expect(h.composer!.filesOpen).toBe(false);
        expect(h.composer!.draft).toBe('Вопрос, который нужно сохранить'); expect(h.composer!.canSend).toBe(true);
        expect(h.research.setEnabled).not.toHaveBeenCalled(); expect(h.research.reset).not.toHaveBeenCalled(); expect(h.research.reload).not.toHaveBeenCalled();
        expect(modelChatApi.send).not.toHaveBeenCalled(); expect(modelChatApi.upload).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
    });
    it('panels hide immediately across an owner change and old project handlers cannot open the new scope', async () => {
        await start(); const oldContext = h.meter!;
        oldContext.onOpenChange!(true); render(); expect(h.meter!.open).toBe(true);
        h.owner.value = 'bob'; render(); expect(h.meter!.open).toBe(false);
        props.projectId = 'prj-two'; render(); oldContext.onOpenChange!(true); render(); expect(h.meter!.open).toBe(false);
        h.meter!.onOpenChange!(true); render(); expect(h.meter!.open).toBe(true);
        oldContext.onOpenChange!(false); render(); expect(h.meter!.open).toBe(true);
        expect(modelChatApi.send).not.toHaveBeenCalled(); expect(h.research.setEnabled).not.toHaveBeenCalled();
    });

    it('keeps saved history and a draft while configuration is collapsed, with project and model still identifiable', async () => {
        h.server = detail({turns: [turn()]});
        props.navigation!.controls = change => {h.changeContext = change; return createElement('div', {className: 'model-chat__workspace-controls'},
            createElement('label', null, 'Проект', createElement('input', {value: 'Проект', readOnly: true})),
            createElement('div', {className: 'model-chat__workspace-error', role: 'alert'}, 'Не удалось обновить модели'));};
        let html = await start();
        expect(button('Настройки чата: проект, модель и режим')['aria-expanded']).toBe(false);
        expect(html).toContain('Личный диалог · Чат-модель'); expect(html).toContain('Проект «Проект»'); expect(html).toContain('Не удалось обновить модели');
        draft('Неотправленный вопрос');
        button('Настройки чата: проект, модель и режим').onClick({}); render();
        expect(button('Настройки чата: проект, модель и режим')['aria-expanded']).toBe(true); expect(h.composer!.draft).toBe('Неотправленный вопрос');
        button('Настройки чата: проект, модель и режим').onClick({}); html = render();
        expect(button('Настройки чата: проект, модель и режим')['aria-expanded']).toBe(false); expect(h.composer!.draft).toBe('Неотправленный вопрос');
        expect(h.messages!.turns).toHaveLength(1); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(html).toContain('Не удалось обновить модели');
    });
    it('exposes essential configuration for an empty dialogue, and summarizes a group without changing its membership', async () => {
        await start(); expect(button('Настройки чата: проект, модель и режим')['aria-expanded']).toBe(true);
        h.hooks.dispose(); h.server = detail({conversation: {...detail().conversation, mode: 'group'}, turns: [turn()],
            participants: [participant(), participant({agentId: 'off', name: 'Отключённый агент', status: 'disabled'})]});
        const html = await start();
        expect(html).toContain('Участники · 2'); expect(html).toContain('Отключённый агент · отключён');
        expect(button('Настройки чата: проект, модель и режим')['aria-expanded']).toBe(false);
        button('Изменить участников').onClick({}); render(); expect(h.editor?.participants).toHaveLength(2);
        expect(modelChatApi.participants).not.toHaveBeenCalled();
    });
    it('Enter/button repeated synchronously produce one real send; accepted send clears its draft and consent once', async () => {
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); await start(); draft('Вопрос'); const send = h.composer!.onSend; send(); send(); await flushSetup(); render(); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(h.composer!.draft).toBe(''); expect(h.research.reset).toHaveBeenCalledOnce();
        const requestId = vi.mocked(modelChatApi.send).mock.calls[0][2]; pending.resolve(detail({turns: [turn({requestId})]})); await flushSetup(); render(); expect(h.messages!.turns).toHaveLength(1); expect(h.messages!.turns[0].status).toBe('done');
    });
    it('invalid research consent or disabled capability preserves the unsent draft without a request', async () => {
        await start(); draft('Исследуй'); h.research.enabled = true; h.research.request = undefined; render(); h.composer!.onSend(); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(h.composer!.draft).toBe('Исследуй');
        h.research.request = {project: true}; h.disabledFlags.add('research_tools'); render(); h.composer!.onSend(); expect(modelChatApi.send).not.toHaveBeenCalled(); h.disabledFlags.clear(); render(); h.composer!.onSend(); await flushSetup(); expect(vi.mocked(modelChatApi.send).mock.calls[0][7]).toEqual({project: true});
    });
    it('failed send retains a retryable tail; repeated retry performs one actual request and edit restores its research consent', async () => {
        h.server = detail({turns: [turn({status: 'failed', answer: undefined, research: {project: true}, prompt: 'Исходный вопрос'})]}); const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.retry).mockReturnValueOnce(pending.promise); await start(); h.messages!.onRetry(); h.messages!.onRetry(); await flushSetup(); expect(modelChatApi.retry).toHaveBeenCalledOnce(); pending.resolve(h.server); await flushSetup(); render(); h.messages!.onEdit(); await flushSetup(); render(); expect(modelChatApi.deleteFailed).toHaveBeenCalledOnce(); expect(h.composer!.draft).toBe('Исходный вопрос'); expect(h.research.restore).toHaveBeenCalledExactlyOnceWith({project: true});
    });
    it('rename failure keeps the modal and text; explicit retry trims the title and closes only after success', async () => {
        await start(); action('rename').onClick({}); render(); expect(rename().open).toBe(true); uiNode(h.ui, 'Input').onChange({target: {value: '  Новое имя  '}}); render(); vi.mocked(modelChatApi.rename).mockRejectedValueOnce(Error('Запись недоступна')); rename().onOk(); await flushSetup(); expect(render()).toContain('Запись недоступна'); expect(rename().open).toBe(true); expect(uiNode(h.ui, 'Input').value).toBe('  Новое имя  '); expect(uiNode(h.ui, 'Input').disabled).not.toBe(true);
        rename().onOk(); await flushSetup(); render(); expect(modelChatApi.rename).toHaveBeenLastCalledWith('chat-1', 1, 'Новое имя', expect.any(AbortSignal)); expect(rename().open).toBe(false); action('rename').onClick({}); render(); rename().onCancel(); render(); expect(rename().open).toBe(false);
    });
    it('owner loss suppresses late rename/delete results and confirmation cannot act for a former owner', async () => {
        await start(); draft('Не терять'); action('delete').onClick({}); h.owner.value = 'bob'; await h.confirmations[0].onOk(); expect(modelChatApi.remove).not.toHaveBeenCalled(); h.owner.value = 'alice'; action('rename').onClick({}); render(); const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.rename).mockReturnValueOnce(pending.promise); rename().onOk(); h.owner.value = 'bob'; pending.resolve({...h.server, conversation: {...h.server.conversation, title: 'PRIVATE'}}); await flushSetup(); render(); expect(rename().open).toBe(true); expect(h.composer!.draft).toBe('Не терять');
    });
    it('delete is explicit, cancellable and preserves a draft on transport failure before a successful retry', async () => {
        await start(); draft('Черновик'); action('delete').onClick({}); action('delete').onClick({}); expect(h.confirmations).toHaveLength(1); h.confirmations[0].onCancel(); action('delete').onClick({}); vi.mocked(modelChatApi.remove).mockRejectedValueOnce(Error('Удаление не подтверждено')); await h.confirmations[1].onOk(); render(); expect(h.composer!.draft).toBe('Черновик');
        action('delete').onClick({}); await h.confirmations[2].onOk(); render(); expect(h.composer!.draft).toBe(''); expect(h.research.reset).toHaveBeenCalledOnce();
    });
    it('same-dialog selection only closes the mobile list; a successful same-model read resets draft after confirmation', async () => {
        await start(); button('Диалоги').onClick({}); render(); h.list!.onSelect('chat-1'); render(); expect(button('Диалоги')['aria-expanded']).toBe(false); expect(modelChatApi.read).not.toHaveBeenCalled();
        draft('Несохранённый текст'); h.list!.onSelect('chat-two'); h.confirmations[0].onCancel(); render(); expect(h.composer!.draft).toBe('Несохранённый текст'); h.list!.onSelect('chat-two'); vi.mocked(modelChatApi.read).mockResolvedValueOnce(detail({conversation: {...detail().conversation, id: 'chat-two'}})); h.confirmations[1].onOk(); await flushSetup(); render(); expect(h.composer!.draft).toBe(''); expect(h.research.reset).toHaveBeenCalledOnce();
        button('Диалоги').onClick({}); render(); button('Вернуться к чату').onClick({}); render(); expect(button('Диалоги')['aria-expanded']).toBe(false);
    });
    it('new dialogue clears the draft only after the actual create response; navigation changes share that confirmation', async () => {
        await start(); draft('Дорогой черновик'); const changed = vi.fn(); h.changeContext!(changed); h.confirmations[0].onCancel(); render(); expect(changed).not.toHaveBeenCalled(); expect(h.composer!.draft).toBe('Дорогой черновик');
        h.list!.onNew(); const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.create).mockReturnValueOnce(pending.promise); h.confirmations[1].onOk(); render(); expect(h.composer!.draft).toBe('Дорогой черновик'); pending.resolve(detail({conversation: {...detail().conversation, id: 'created'}})); await flushSetup(); render(); expect(h.composer!.draft).toBe(''); h.changeContext!(changed); expect(changed).toHaveBeenCalledOnce();
    });
    it('switching to another model keeps the accepted HTTP until its old scope unmounts, without cancelling or asking about it', async () => {
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); const other = {...detail().conversation, id: 'other', modelId: 'model/other'}; props.navigation!.items = [other]; await start(); draft('Вопрос'); h.composer!.onSend(); await flushSetup(); render(); const signal = vi.mocked(modelChatApi.send).mock.calls[0][5];
        h.list!.onSelect('other'); expect(h.confirmations).toHaveLength(0); expect(signal.aborted).toBe(false); expect(modelChatApi.cancel).not.toHaveBeenCalled(); expect(h.messages!.turns.at(-1)?.status).toBe('pending'); expect(props.navigation!.onSelect).toHaveBeenCalledExactlyOnceWith(other);
        h.hooks.dispose(); expect(signal.aborted).toBe(true); props.model = {...model, id: other.modelId}; h.server = detail({conversation: other}); await start(); pending.resolve(detail({turns: [turn({answer: {content: 'LATE', finishReason: 'stop'}})]})); await flushSetup(); render(); expect(h.messages!.turns).toEqual([]);
    });
    it('a failed cross-model prefetch preserves the original HTTP and GET progress without resending or cancelling its task', async () => {
        const pending = deferredSetup<IModelChatDetail>(), opening = deferredSetup<IModelChatDetail>(), other = {...detail().conversation, id: 'other', modelId: 'model/other'};
        vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); props.navigation!.items = [other];
        props.navigation!.onSelect = vi.fn(async item => {props.navigation!.opening = true; try {await modelChatApi.read(item.id, new AbortController().signal);} catch {props.navigation!.error = 'Диалог сейчас недоступен';} finally {props.navigation!.opening = false;}});
        vi.mocked(modelChatApi.read).mockImplementation(async id => id === 'other' ? opening.promise : h.server); await start(); draft('Продолжай'); h.composer!.onSend(); await flushSetup(); render(); const sent = vi.mocked(modelChatApi.send).mock.calls[0];
        const accepted = turn({id: 'accepted', requestId: sent[2], prompt: sent[3], status: 'pending', answer: undefined}); h.server = detail({turns: [accepted]}); h.list!.onSelect('other'); render();
        expect(sent[5].aborted).toBe(false); await vi.advanceTimersByTimeAsync(1000); await flushSetup(); render(); expect(h.messages!.turns).toHaveLength(1); expect(h.messages!.turns[0]).toMatchObject({id: accepted.id, requestId: sent[2], prompt: sent[3], status: 'pending'});
        opening.reject(Error('Чужой диалог недоступен')); await flushSetup(); expect(render()).toContain('Диалог сейчас недоступен'); expect(sent[5].aborted).toBe(false);
        h.server = detail({turns: [{...accepted, status: 'done', answer: {content: 'Готово в прежнем диалоге', finishReason: 'stop'}}]}); await vi.advanceTimersByTimeAsync(2000); await flushSetup(); render();
        expect(h.messages!.turns.at(-1)).toMatchObject({requestId: sent[2], status: 'done', answer: {content: 'Готово в прежнем диалоге'}}); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(modelChatApi.retry).not.toHaveBeenCalled(); expect(modelChatApi.cancel).not.toHaveBeenCalled(); pending.resolve(h.server); await flushSetup();
    });
    it('a failed same-model read before the first poll reconciles the old accepted task and follows its result without resending', async () => {
        const pending = deferredSetup<IModelChatDetail>(), opening = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); await start(); draft('Не потерять работу'); h.composer!.onSend(); await flushSetup(); render(); const sent = vi.mocked(modelChatApi.send).mock.calls[0];
        const accepted = turn({id: 'accepted', requestId: sent[2], prompt: sent[3], status: 'pending', answer: undefined}); h.server = detail({turns: [accepted]}); vi.mocked(modelChatApi.read).mockImplementation(async id => id === 'chat-two' ? opening.promise : h.server);
        h.list!.onSelect('chat-two'); render(); expect(h.messages!.turns.at(-1)).toMatchObject({requestId: sent[2], status: 'pending'}); opening.reject(Error('Другой диалог недоступен')); await flushSetup(); expect(render()).toContain('Другой диалог недоступен'); expect(h.messages!.turns).toEqual([accepted]);
        h.server = detail({turns: [{...accepted, status: 'done', answer: {content: 'Сохранённый результат', finishReason: 'stop'}}]}); await vi.advanceTimersByTimeAsync(1000); await flushSetup(); render();
        expect(h.messages!.turns.at(-1)).toMatchObject({requestId: sent[2], status: 'done', answer: {content: 'Сохранённый результат'}}); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(modelChatApi.retry).not.toHaveBeenCalled(); expect(modelChatApi.cancel).not.toHaveBeenCalled(); pending.resolve(h.server); await flushSetup();
    });
    it('switching model during upload aborts the file reader before opening its new model scope', async () => {
        const reading = deferredSetup<string>(), other = {...detail().conversation, id: 'other', modelId: 'model/other'}; vi.mocked(chatFileBase64).mockReturnValueOnce(reading.promise); props.navigation!.items = [other]; await start(); h.composer!.onFiles([new File(['x'], 'notes.md')]); await flushSetup(); render(); h.list!.onSelect('other'); h.confirmations[0].onOk();
        expect(vi.mocked(chatFileBase64).mock.calls[0][1].aborted).toBe(true); expect(props.navigation!.onSelect).toHaveBeenCalledExactlyOnceWith(other); reading.resolve('eA=='); await flushSetup(); expect(modelChatApi.upload).not.toHaveBeenCalled();
    });
    it('late failed-message edit cannot overwrite another owner draft or restore its research settings', async () => {
        h.server = detail({turns: [turn({status: 'failed', answer: undefined, research: {project: true}})]}); await start(); draft('Текущий черновик'); const read = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.read).mockReturnValueOnce(read.promise); h.messages!.onEdit(); h.owner.value = 'bob'; read.resolve(h.server); await flushSetup(); render(); expect(h.composer!.draft).toBe('Текущий черновик'); expect(h.research.restore).not.toHaveBeenCalled(); expect(modelChatApi.deleteFailed).not.toHaveBeenCalled();
    });
    it('explicit stop aborts inference and persists the pending server turn cancellation without accepting a late answer', async () => {
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); await start(); draft('Вопрос'); h.composer!.onSend(); await flushSetup(); const args = vi.mocked(modelChatApi.send).mock.calls[0]; h.server = detail({turns: [turn({id: 'server-turn', requestId: args[2], status: 'pending', answer: undefined})]}); render(); h.composer!.onStop(); expect(args[5].aborted).toBe(true); await flushSetup(); render(); expect(modelChatApi.cancel).toHaveBeenCalledOnce(); expect(h.messages!.turns.at(-1)?.status).toBe('cancelled'); pending.resolve(detail({turns: [turn()]})); await flushSetup(); render(); expect(h.messages!.turns.at(-1)?.status).toBe('cancelled');
    });
    it('document rejection is visible; accepted files clear it, support preview/close and remove only on confirmation from API', async () => {
        await start(); h.composer!.onReject('Нужен текстовый документ'); expect(render()).toContain('Нужен текстовый документ'); h.disabledFlags.add('model_chat'); render(); h.composer!.onFiles([new File(['x'], 'notes.md')]); expect(modelChatApi.upload).not.toHaveBeenCalled(); expect(render()).toContain('Нужен текстовый документ');
        h.disabledFlags.clear(); render(); h.composer!.onFiles([new File(['x'], 'notes.md')]); await flushSetup(); expect(render()).not.toContain('Нужен текстовый документ'); expect(modelChatApi.upload).toHaveBeenCalledOnce(); h.attachments!.onPreview('file-one'); render(); expect(h.preview).toMatchObject({attachmentId: 'file-one', conversationId: 'chat-1'}); h.preview!.onClose(); render(); expect(h.preview).toBeUndefined();
        h.messages!.onPreview('file-one'); render(); expect(h.preview).toBeDefined(); h.preview!.onClose(); h.attachments!.onRemove('file-one'); await flushSetup(); render(); expect(modelChatApi.removeAttachment).toHaveBeenCalledOnce(); expect(h.attachments!.files).toEqual([]);
    });
    it('closing an accepted pending turn only hides the UI; reopening reads its pending and final state without resending', async () => {
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); await start(); draft('Продолжай без окна'); h.composer!.onSend(); await flushSetup(); render();
        const sent = vi.mocked(modelChatApi.send).mock.calls[0], accepted = turn({id: 'accepted', requestId: sent[2], prompt: sent[3], status: 'pending', answer: undefined}); h.server = detail({turns: [accepted]});
        h.research.enabled = true; render(); outer().onCancel(); expect(h.close).toHaveBeenCalledOnce(); expect(h.confirmations).toHaveLength(0); expect(modelChatApi.cancel).not.toHaveBeenCalled();
        h.hooks.dispose(); expect(sent[5].aborted).toBe(true); pending.resolve(detail({turns: [turn({requestId: sent[2], answer: {content: 'LATE HTTP', finishReason: 'stop'}})]})); await flushSetup();
        props.navigation = undefined; vi.mocked(modelChatApi.list).mockResolvedValue([h.server.conversation]); await start(); expect(modelChatApi.read).toHaveBeenCalledWith('chat-1', expect.any(AbortSignal)); expect(h.messages!.turns).toEqual([accepted]);
        h.server = detail({turns: [{...accepted, status: 'done', answer: {content: 'Сохранённый ответ', finishReason: 'stop'}}]}); await vi.advanceTimersByTimeAsync(1000); await flushSetup(); render();
        expect(h.messages!.turns.at(-1)).toMatchObject({requestId: sent[2], status: 'done', answer: {content: 'Сохранённый ответ'}}); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(modelChatApi.retry).not.toHaveBeenCalled(); expect(modelChatApi.cancel).not.toHaveBeenCalled();
    });
    it('close with an unsent draft explains its loss and keeps the accepted request running after cancellation of the prompt', async () => {
        h.server = detail({turns: [turn({status: 'pending', answer: undefined})]}); await start(); draft('Не потерять'); outer().onCancel();
        expect(h.confirmations[0].content).toBe('Неотправленный текст будет потерян. Принятые запросы продолжат выполняться.'); h.confirmations[0].onCancel(); render();
        expect(h.composer!.draft).toBe('Не потерять'); expect(h.close).not.toHaveBeenCalled(); expect(modelChatApi.cancel).not.toHaveBeenCalled();
    });
    it('closing after a failed file read still confirms loss with an empty text draft; cancelling keeps the selected file', async () => {
        vi.mocked(chatFileBase64).mockRejectedValueOnce(Error('Не удалось прочитать файл')); await start(); h.composer!.onFiles([new File(['x'], 'notes.md')]); await flushSetup(); render();
        expect(h.composer!.draft).toBe(''); expect(h.composer!.uploading).toBe(false); expect(h.attachments!.uploads[0]).toMatchObject({name: 'notes.md', state: 'failed'}); outer().onCancel();
        expect(h.confirmations).toHaveLength(1); expect(h.confirmations[0].content).toBe('Выбранные файлы и неотправленный текст будут потеряны. Принятые запросы продолжат выполняться.'); h.confirmations[0].onCancel(); render();
        expect(h.attachments!.uploads[0]).toMatchObject({name: 'notes.md', state: 'failed'}); expect(h.close).not.toHaveBeenCalled(); expect(modelChatApi.upload).not.toHaveBeenCalled(); expect(modelChatApi.cancel).not.toHaveBeenCalled();
    });
    it.each(['failed', 'cancelled'] as const)('allows composing the next task after an automatic %s discussion without altering its history', async status => {
        const previous = turn({status, answer: undefined, responses: [response()], discussion: {mode: 'automatic', callsStarted: 3, maxCalls: 5}}); h.server = detail({turns: [previous]}); await start(); draft('Следующая задача');
        expect(h.composer!.canSend).toBe(true); expect(h.messages!.turns).toEqual([previous]); h.composer!.onSend(); await flushSetup(); expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(modelChatApi.retry).not.toHaveBeenCalled(); expect(modelChatApi.complete).not.toHaveBeenCalled();
    });
    it('close during file reading requires one confirmation and aborts upload, cleanup destroys a pending confirmation', async () => {
        const reading = deferredSetup<string>(); vi.mocked(chatFileBase64).mockReturnValueOnce(reading.promise); await start(); h.composer!.onFiles([new File(['x'], 'notes.md')]); await flushSetup(); render(); outer().onCancel(); outer().onCancel(); expect(h.confirmations).toHaveLength(1); expect(h.confirmations[0].content).toContain('Загрузка будет прервана'); h.confirmations[0].onOk(); expect(vi.mocked(chatFileBase64).mock.calls[0][1].aborted).toBe(true); expect(h.close).toHaveBeenCalledOnce(); reading.resolve('eA=='); await flushSetup(); expect(modelChatApi.upload).not.toHaveBeenCalled();
        draft('Другой черновик'); outer().onCancel(); h.hooks.dispose(); expect(h.confirmations[1].destroy).toHaveBeenCalledOnce();
    });
    it('refresh and early-history actions are lazy and serialized; a failed page keeps existing messages for retry', async () => {
        h.server = detail({turns: [turn()], history: {hasMore: true, nextCursor: 'cursor-one'}}); await start(); expect(modelChatApi.history).not.toHaveBeenCalled(); h.list!.onRefresh(); await flushSetup(); expect(props.navigation!.onRefresh).toHaveBeenCalledOnce(); render();
        vi.mocked(modelChatApi.history).mockRejectedValueOnce(Error('Страница недоступна')); h.messages!.onLoadEarlier!(); h.messages!.onLoadEarlier!(); await flushSetup(); render(); expect(modelChatApi.history).toHaveBeenCalledOnce(); expect(h.messages!.historyError).toBe('Страница недоступна'); expect(h.messages!.turns).toHaveLength(1);
        vi.mocked(modelChatApi.history).mockResolvedValueOnce({turns: [turn({id: 'older', requestId: 'older'})], attachments: [], history: {hasMore: false, nextCursor: null}}); h.messages!.onLoadEarlier!(); await flushSetup(); render(); expect(h.messages!.turns.map(value => value.id)).toEqual(['older', 'turn-1']);
    });
    it('project agents join this existing dialogue without changing its history or creating another conversation', async () => {
        await start(); button('Участники').onClick({}); render(); expect(h.editor).toMatchObject({joining: true, inline: true, participants: []}); const editor = h.editor!; expect(await editor.onSave(['agent-dev'])).toBe(true); editor.onClose(); render(); expect(modelChatApi.participants).toHaveBeenCalledOnce(); expect(h.messages!.group).toBe(true);
        button('Изменить участников').onClick({}); render(); expect(h.editor?.participants?.[0].agentId).toBe('agent-dev'); h.disabledFlags.add('group_chat'); render(); expect(await h.editor!.onSave([])).toBe(false); expect(modelChatApi.participants).toHaveBeenCalledOnce(); h.disabledFlags.clear(); h.editor!.onClose(); render();
        expect(modelChatApi.create).not.toHaveBeenCalled();
    });
    it('participants are available before the first question and saving them preserves its draft without inference', async () => {
        render(); await flushSetup(); render(); draft('Обсудите этот черновик');
        button('Участники').onClick({}); render(); expect(h.editor).toMatchObject({inline: true, joining: false}); expect(h.editor?.participants).toBeUndefined();
        expect(modelChatApi.create).not.toHaveBeenCalled(); expect(modelChatApi.send).not.toHaveBeenCalled();
        expect(await h.editor!.onSave(['agent-dev'])).toBe(true); h.editor!.onClose(); render();
        expect(modelChatApi.create).toHaveBeenCalledExactlyOnceWith(model, 'prj-one', expect.any(AbortSignal), ['agent-dev']);
        expect(h.composer!.draft).toBe('Обсудите этот черновик'); expect(h.messages!.group).toBe(true); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it('a failed initial participant save keeps the draft and editor available for an explicit retry', async () => {
        render(); await flushSetup(); render(); draft('Не терять вопрос'); button('Участники').onClick({}); render();
        vi.mocked(modelChatApi.create).mockRejectedValueOnce(Error('Состав не сохранён'));
        expect(await h.editor!.onSave(['agent-dev'])).toBe(false); expect(render()).toContain('Состав не сохранён');
        expect(h.editor).toBeDefined(); h.editor!.onClose(); render(); expect(h.composer!.draft).toBe('Не терять вопрос'); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it.each(['cancel', 'save'] as const)('closing participants after %s returns focus to the current trigger and preserves its draft', async action => {
        h.server = detail({conversation: {...detail().conversation, mode: 'group'}, participants: [participant()], turns: [turn()]});
        await start(); draft('Черновик после состава'); const trigger = {isConnected: true, matches: vi.fn(() => false), focus: vi.fn()};
        button('Изменить участников').onClick({currentTarget: trigger}); render();
        if (action === 'save') expect(await h.editor!.onSave(['agent-dev'])).toBe(true);
        h.editor!.onClose(); render(); expect(trigger.focus).toHaveBeenCalledOnce(); expect(h.composer!.draft).toBe('Черновик после состава'); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it.each(['project', 'owner'] as const)('an old participant editor cannot return focus across a changed %s scope', async scope => {
        await start(); const trigger = {isConnected: true, matches: vi.fn(() => false), focus: vi.fn()}; button('Участники').onClick({currentTarget: trigger}); render(); const old = h.editor!;
        if (scope === 'project') props.projectId = 'other-project'; else h.owner.value = 'bob';
        render(); old.onClose(); render(); expect(trigger.focus).not.toHaveBeenCalled(); expect(modelChatApi.send).not.toHaveBeenCalled();
    });
    it('conversation actions retain feature guards without blocking an existing group history', async () => {
        h.server = detail({conversation: {...detail().conversation, mode: 'group'}, participants: [participant()], turns: [turn()]});
        h.disabledFlags.add('model_chat'); await start();
        expect(action('new').disabled).toBe(true); expect(action('rename').disabled).toBe(false); expect(action('delete').danger).toBe(true);
        expect(h.messages!.turns).toHaveLength(1); expect(modelChatApi.create).not.toHaveBeenCalled();
    });
    it('Escape closes only the open actions menu and returns focus to its trigger without consuming navigation keys', async () => {
        await start(); uiNode(h.ui, 'Dropdown').onOpenChange(true); render();
        expect(button('Действия диалога')['aria-expanded']).toBe(true);
        const arrow = {key: 'ArrowDown', preventDefault: vi.fn(), stopPropagation: vi.fn()}; uiNode(h.ui, 'Dropdown').dropdownRender(null).props.onKeyDownCapture(arrow);
        expect(arrow.preventDefault).not.toHaveBeenCalled(); expect(arrow.stopPropagation).not.toHaveBeenCalled();
        const escape = {key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn()}; uiNode(h.ui, 'Dropdown').dropdownRender(null).props.onKeyDownCapture(escape); render();
        expect(uiNode(h.ui, 'Dropdown').open).toBe(false); expect(button('Действия диалога')['aria-expanded']).toBe(false);
        expect(escape.preventDefault).toHaveBeenCalledOnce(); expect(escape.stopPropagation).toHaveBeenCalledOnce(); expect(h.focusTrigger).toHaveBeenCalledOnce();
        expect(h.close).not.toHaveBeenCalled(); expect(rename().open).toBe(false); expect(modelChatApi.remove).not.toHaveBeenCalled();
    });
    it('menu selection and outside closing leave actions closed, while Escape on its trigger stays within chat', async () => {
        await start(); uiNode(h.ui, 'Dropdown').onOpenChange(true); render(); action('rename').onClick(); uiNode(h.ui, 'Dropdown').menu.onClick(); render();
        expect(rename().open).toBe(true); expect(uiNode(h.ui, 'Dropdown').open).toBe(false); rename().onCancel(); render();
        uiNode(h.ui, 'Dropdown').onOpenChange(true); render(); uiNode(h.ui, 'Dropdown').onOpenChange(false); render(); expect(uiNode(h.ui, 'Dropdown').open).toBe(false);
        uiNode(h.ui, 'Dropdown').onOpenChange(true); render(); const escape = {key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn()}; button('Действия диалога').onKeyDown(escape); render();
        expect(uiNode(h.ui, 'Dropdown').open).toBe(false); expect(h.focusTrigger).toHaveBeenCalledOnce(); expect(escape.stopPropagation).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled();
    });
    it('group status, partial-answer completion and project_search off preserve honest context and usage', async () => {
        h.server = detail({conversation: {...detail().conversation, mode: 'group'}, participants: [participant(), participant({agentId: 'two', name: 'Два', status: 'disabled'}), participant({agentId: 'three', name: 'Три', status: 'removed'}), participant({agentId: 'four', name: 'Четыре', status: 'blocked'})], projectContext: evidence(), turns: [turn({status: 'failed', processingStage: 'researching', responses: [response(), response({id: 'bad', status: 'failed', answer: undefined})]})]}); h.disabledFlags.add('project_search'); const html = await start(); expect(html).toContain('Два · отключён'); expect(html).toContain('Три · удалён'); expect(html).toContain('Четыре · недоступен'); expect(h.projectContext).toMatchObject({status: 'metadata', sources: []}); expect(h.meter).toMatchObject({phase: 'researching', failed: true, usage: turn().answer!.usage});
        h.messages!.onComplete!(); await flushSetup(); render(); expect(modelChatApi.complete).toHaveBeenCalledOnce(); expect(h.messages!.turns[0].status).toBe('done');
    });
    it('blocked model and index errors stay visible while confirmed history and explicit refresh remain readable', async () => {
        h.server = detail({turns: [turn()]}); props.unavailableReason = 'Модель временно недоступна'; props.navigation!.error = 'Список диалогов не обновился'; const html = await start(); expect(html).toContain('Модель временно недоступна'); expect(html).toContain('Список диалогов не обновился'); expect(h.messages!.turns).toHaveLength(1); expect(h.composer!.canSend).toBe(false); h.list!.onRefresh(); await flushSetup(); expect(props.navigation!.onRefresh).toHaveBeenCalledOnce();
    });
    it('non-global group entry uses a modal editor; loading, missing project and context guards remain explicit', async () => {
        props.navigation = undefined; props.projectId = undefined; props.projectName = undefined; vi.mocked(modelChatApi.list).mockResolvedValueOnce([h.server.conversation]); await start(); expect(h.ui.nodes.some(node => node.kind === 'Button' && node.text === 'Участники')).toBe(false); h.context.rejected = true; draft('Вопрос'); expect(h.composer!.canSend).toBe(false); h.context.rejected = false; h.known = false; render(); expect(h.composer!.disabled).toBe(true);
        h.hooks.dispose(); h.known = true; props.projectId = 'prj-one'; h.server = detail({conversation: {...detail().conversation, mode: 'group'}, participants: []}); vi.mocked(modelChatApi.list).mockResolvedValueOnce([h.server.conversation]); await start(); button('Изменить участников').onClick({}); render(); expect(h.editor?.inline).toBe(false); expect(h.editor?.participants).toEqual([]);
    });
});
