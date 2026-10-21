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
type Research = ReturnType<typeof import('../src/features/ModelChat/useChatResearch').useChatResearch>;
type Confirmation = {title: string; content: string; onOk: () => unknown; onCancel: () => void; destroy: ReturnType<typeof vi.fn>};
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture'), {modalUi} = await import('./modal-actions.fixture');
    const owner = {value: 'alice', active: true};
    return {hooks: adminSetupHooks(), ui: modalUi(), owner, disabledFlags: new Set<TFeatureFlagKey>(), known: true, close: vi.fn(), server: null as unknown as IModelChatDetail,
        composer: undefined as Composer | undefined, messages: undefined as Messages | undefined, attachments: undefined as Attachments | undefined, editor: undefined as Editor | undefined,
        preview: undefined as Preview | undefined, list: undefined as List | undefined, meter: undefined as Meter | undefined, projectContext: undefined as unknown,
        research: {} as Research, confirmations: [] as Confirmation[], changeContext: undefined as undefined | ((action: () => void) => void),
        context: {context: undefined as IModelChatDetail['context'] | undefined, loading: false, error: undefined as string | undefined, rejected: false},
        capture: () => { const key = owner.value; return () => owner.active && owner.value === key; }};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect}));
vi.mock('@ant-design/icons', () => ({DeleteOutlined: () => null, EditOutlined: () => null, MenuOutlined: () => null, PlusOutlined: () => null, TeamOutlined: () => null}));
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
vi.mock('../src/features/ModelChat/ChatResearchControls', () => ({ChatResearchControls: () => null}));
vi.mock('antd', async () => ({...modalAntd(h.ui, (await import('react')).createElement), Tooltip: ({children}: {children?: ReactNode}) => children,
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
        await start(); button('Переименовать диалог').onClick({}); render(); expect(rename().open).toBe(true); uiNode(h.ui, 'Input').onChange({target: {value: '  Новое имя  '}}); render(); vi.mocked(modelChatApi.rename).mockRejectedValueOnce(Error('Запись недоступна')); rename().onOk(); await flushSetup(); expect(render()).toContain('Запись недоступна'); expect(rename().open).toBe(true);
        rename().onOk(); await flushSetup(); render(); expect(modelChatApi.rename).toHaveBeenLastCalledWith('chat-1', 1, 'Новое имя', expect.any(AbortSignal)); expect(rename().open).toBe(false); button('Переименовать диалог').onClick({}); render(); rename().onCancel(); render(); expect(rename().open).toBe(false);
    });
    it('owner loss suppresses late rename/delete results and confirmation cannot act for a former owner', async () => {
        await start(); draft('Не терять'); button('Удалить диалог').onClick({}); h.owner.value = 'bob'; await h.confirmations[0].onOk(); expect(modelChatApi.remove).not.toHaveBeenCalled(); h.owner.value = 'alice'; button('Переименовать диалог').onClick({}); render(); const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.rename).mockReturnValueOnce(pending.promise); rename().onOk(); h.owner.value = 'bob'; pending.resolve({...h.server, conversation: {...h.server.conversation, title: 'PRIVATE'}}); await flushSetup(); render(); expect(rename().open).toBe(true); expect(h.composer!.draft).toBe('Не терять');
    });
    it('delete is explicit, cancellable and preserves a draft on transport failure before a successful retry', async () => {
        await start(); draft('Черновик'); button('Удалить диалог').onClick({}); button('Удалить диалог').onClick({}); expect(h.confirmations).toHaveLength(1); h.confirmations[0].onCancel(); button('Удалить диалог').onClick({}); vi.mocked(modelChatApi.remove).mockRejectedValueOnce(Error('Удаление не подтверждено')); await h.confirmations[1].onOk(); render(); expect(h.composer!.draft).toBe('Черновик');
        button('Удалить диалог').onClick({}); await h.confirmations[2].onOk(); render(); expect(h.composer!.draft).toBe(''); expect(h.research.reset).toHaveBeenCalledOnce();
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
    it('switching to another model aborts an owned send synchronously before opening the new conversation', async () => {
        const pending = deferredSetup<IModelChatDetail>(); vi.mocked(modelChatApi.send).mockReturnValueOnce(pending.promise); const other = {...detail().conversation, id: 'other', modelId: 'model/other'}; props.navigation!.items = [other]; await start(); draft('Вопрос'); h.composer!.onSend(); await flushSetup(); render(); const signal = vi.mocked(modelChatApi.send).mock.calls[0][5];
        h.list!.onSelect('other'); expect(props.navigation!.onSelect).not.toHaveBeenCalled(); h.confirmations[0].onOk(); expect(signal.aborted).toBe(true); expect(props.navigation!.onSelect).toHaveBeenCalledExactlyOnceWith(other); pending.resolve(detail({turns: [turn({answer: {content: 'LATE', finishReason: 'stop'}})]})); await flushSetup(); render(); expect(h.messages!.turns.some(value => value.answer?.content === 'LATE')).toBe(false);
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
    it('close during file reading requires one confirmation and aborts upload, cleanup destroys a pending question', async () => {
        const reading = deferredSetup<string>(); vi.mocked(chatFileBase64).mockReturnValueOnce(reading.promise); await start(); h.composer!.onFiles([new File(['x'], 'notes.md')]); await flushSetup(); render(); outer().onCancel(); outer().onCancel(); expect(h.confirmations).toHaveLength(1); expect(h.confirmations[0].content).toContain('Загрузка будет прервана'); h.confirmations[0].onOk(); expect(vi.mocked(chatFileBase64).mock.calls[0][1].aborted).toBe(true); expect(h.close).toHaveBeenCalledOnce(); reading.resolve('eA=='); await flushSetup(); expect(modelChatApi.upload).not.toHaveBeenCalled();
        draft('Другой черновик'); outer().onCancel(); h.hooks.dispose(); expect(h.confirmations[1].destroy).toHaveBeenCalledOnce();
    });
    it('refresh and early-history actions are lazy and serialized; a failed page keeps existing messages for retry', async () => {
        h.server = detail({turns: [turn()], history: {hasMore: true, nextCursor: 'cursor-one'}}); await start(); expect(modelChatApi.history).not.toHaveBeenCalled(); h.list!.onRefresh(); await flushSetup(); expect(props.navigation!.onRefresh).toHaveBeenCalledOnce(); render();
        vi.mocked(modelChatApi.history).mockRejectedValueOnce(Error('Страница недоступна')); h.messages!.onLoadEarlier!(); h.messages!.onLoadEarlier!(); await flushSetup(); render(); expect(modelChatApi.history).toHaveBeenCalledOnce(); expect(h.messages!.historyError).toBe('Страница недоступна'); expect(h.messages!.turns).toHaveLength(1);
        vi.mocked(modelChatApi.history).mockResolvedValueOnce({turns: [turn({id: 'older', requestId: 'older'})], attachments: [], history: {hasMore: false, nextCursor: null}}); h.messages!.onLoadEarlier!(); await flushSetup(); render(); expect(h.messages!.turns.map(value => value.id)).toEqual(['older', 'turn-1']);
    });
    it('project agents can join this existing dialogue or create a separate group without changing existing history implicitly', async () => {
        await start(); button('Добавить агентов').onClick({}); render(); expect(h.editor).toMatchObject({joining: true, inline: true, participants: []}); const editor = h.editor!; expect(await editor.onSave(['agent-dev'])).toBe(true); editor.onClose(); render(); expect(modelChatApi.participants).toHaveBeenCalledOnce(); expect(h.messages!.group).toBe(true);
        button('Участники').onClick({}); render(); expect(h.editor?.participants?.[0].agentId).toBe('agent-dev'); h.disabledFlags.add('group_chat'); render(); expect(await h.editor!.onSave([])).toBe(false); expect(modelChatApi.participants).toHaveBeenCalledOnce(); h.disabledFlags.clear(); h.editor!.onClose(); render();
        h.list!.onNewGroup!(); render(); expect(h.editor?.participants).toBeUndefined(); expect(await h.editor!.onSave(['agent-new'])).toBe(true); expect(modelChatApi.create).toHaveBeenCalledWith(model, 'prj-one', expect.any(AbortSignal), ['agent-new']); h.editor!.onClose(); render(); expect(h.composer!.draft).toBe('');
    });
    it('group status, partial-answer completion and project_search off preserve honest context and usage', async () => {
        h.server = detail({conversation: {...detail().conversation, mode: 'group'}, participants: [participant(), participant({agentId: 'two', name: 'Два', status: 'disabled'}), participant({agentId: 'three', name: 'Три', status: 'removed'}), participant({agentId: 'four', name: 'Четыре', status: 'blocked'})], projectContext: evidence(), turns: [turn({status: 'failed', processingStage: 'researching', responses: [response(), response({id: 'bad', status: 'failed', answer: undefined})]})]}); h.disabledFlags.add('project_search'); const html = await start(); expect(html).toContain('Два · отключён'); expect(html).toContain('Три · удалён'); expect(html).toContain('Четыре · недоступен'); expect(h.projectContext).toMatchObject({status: 'metadata', sources: []}); expect(h.meter).toMatchObject({phase: 'researching', failed: true, usage: turn().answer!.usage});
        h.messages!.onComplete!(); await flushSetup(); render(); expect(modelChatApi.complete).toHaveBeenCalledOnce(); expect(h.messages!.turns[0].status).toBe('done');
    });
    it('blocked model and index errors stay visible while confirmed history and explicit refresh remain readable', async () => {
        h.server = detail({turns: [turn()]}); props.unavailableReason = 'Модель временно недоступна'; props.navigation!.error = 'Список диалогов не обновился'; const html = await start(); expect(html).toContain('Модель временно недоступна'); expect(html).toContain('Список диалогов не обновился'); expect(h.messages!.turns).toHaveLength(1); expect(h.composer!.canSend).toBe(false); h.list!.onRefresh(); await flushSetup(); expect(props.navigation!.onRefresh).toHaveBeenCalledOnce();
    });
    it('non-global group entry uses a modal editor; loading, missing project and context guards remain explicit', async () => {
        props.navigation = undefined; props.projectId = undefined; props.projectName = undefined; vi.mocked(modelChatApi.list).mockResolvedValueOnce([h.server.conversation]); await start(); expect(h.list!.onNewGroup).toBeUndefined(); h.context.rejected = true; draft('Вопрос'); expect(h.composer!.canSend).toBe(false); h.context.rejected = false; h.known = false; render(); expect(h.composer!.disabled).toBe(true);
        h.hooks.dispose(); h.known = true; props.projectId = 'prj-one'; h.server = detail({conversation: {...detail().conversation, mode: 'group'}, participants: []}); vi.mocked(modelChatApi.list).mockResolvedValueOnce([h.server.conversation]); await start(); button('Участники').onClick({}); render(); expect(h.editor?.inline).toBe(false); expect(h.editor?.participants).toEqual([]);
    });
});
