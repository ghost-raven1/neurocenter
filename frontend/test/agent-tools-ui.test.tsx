// @vitest-environment jsdom
import {act,createElement,StrictMode,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AgentToolsControls} from '../src/features/AgentTools/AgentToolsControls';
import {AgentToolHistory} from '../src/features/AgentTools/AgentToolHistory';
import {useAgentTools} from '../src/features/AgentTools/useAgentTools';
import {useModelChat} from '../src/features/ModelChat/useModelChat';
import {ChatComposer} from '../src/features/ModelChat/ChatComposer';
import {ProjectChatComposer} from '../src/features/ProjectChat/ProjectChatComposer';
import {detail,model,participant,turn} from './model-chat-fixtures';
import {projectRoom,projectMessage} from './project-chat-fixtures';
import {deferredSetup} from './admin-setup-hooks.fixture';
import type {AgentToolCapabilities,AgentToolGrant} from '../src/features/AgentTools/types';
import type {IModelChatDetail} from '../src/features/ModelChat/types';
import type {ProjectChatReceipt} from '../src/features/ProjectChat/types';
const h = vi.hoisted(() => ({owner: 'alice',caseId: 0}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const owner = h.owner; return {scope: owner,captureOwner: () => () => owner === h.owner};}}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({FEATURE_FLAGS_CHANGED: 'tools-test-flags',useFeatureAvailability: () => ({enabled: true,reason: ''})}));
vi.mock('../src/features/TabNotifications/useTabWatch', () => ({useTabWatch: () => undefined}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: () => undefined}));
vi.mock('../src/features/TabNotifications/tracker', () => ({tabNotifications: {expect: vi.fn()}}));
vi.mock('../src/features/ModelChat/ChatToolPopover', () => ({ChatToolPopover: ({children}: {children: React.ReactNode}) => <>{children}</>}));
vi.mock('../src/common/components/FileDropZone/FileDropZone', () => ({FileDropZone: () => null}));
vi.mock('../src/features/ProjectChat/ProjectChatPanel', () => ({ProjectChatPanel: ({children}: {children: React.ReactNode}) => <>{children}</>}));
vi.mock('../src/features/AgentTools/api', () => ({agentToolsApi: {capabilities: vi.fn(),steps: vi.fn(),step: vi.fn()}}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {list: vi.fn(),read: vi.fn(),send: vi.fn(),create: vi.fn(),retry: vi.fn()}}));
import {agentToolsApi} from '../src/features/AgentTools/api';
import {modelChatApi} from '../src/features/ModelChat/api';
const cap: AgentToolCapabilities = {protocol: 'json-actions-v1',available: true,rag: {available: true},systemRoles: {available: true},publicChats: {available: true,models: [{id: 'embedding-one',name: 'Первая подходящая',pin: 'a'.repeat(64),dimension: 3}]},mcp: {available: false,reason: 'MCP недоступен в этом контуре'},limits: {steps: 3,deadlineMs: 120000}};
const safe: AgentToolGrant = {protocol: 'json-actions-v1',rag: true,systemRoles: true};
let root: Root,container: HTMLDivElement;
const settle = async () => act(async () => {await new Promise(done => setTimeout(done,15));});
const render = async (element: React.ReactElement) => {await act(async () => {root.render(<StrictMode>{element}</StrictMode>);}); await settle();};
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
const check = (text: string) => [...container.querySelectorAll('label')].find(node => node.textContent === text)?.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const click = async (node: HTMLElement) => {expect(node).toBeTruthy(); await act(async () => {node.click();}); await settle();};
const type = async (selector: string,value: string) => {await act(async () => {const node = container.querySelector<HTMLTextAreaElement>(selector)!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles: true}));});await settle();};
function Personal({group = false}: {group?: boolean}) {
    const initial = detail({conversation: {...detail().conversation,mode: group ? 'group' : 'model'},participants: group ? [participant()] : undefined});
    const chat = useModelChat(model,'prj-one','',{initialDetail: initial,autoSelect: false}), tools = useAgentTools('personal-' + h.caseId,'prj-one'), [body,setBody] = useState('');
    const send = () => {if (!tools.blocked && chat.send(body,undefined,tools.request,tools.afterSubmission())) setBody('');};
    return <><AgentToolsControls value={tools} projectId="prj-one"/><ChatComposer draft={body} disabled={!!chat.activity} canSend={!!body.trim() && !tools.blocked && !chat.activity} sending={chat.busy} uploading={false} onDraft={setBody} onSend={send} onStop={() => undefined} onFiles={() => undefined} onReject={() => undefined} onCancelUpload={() => undefined} participants={group ? [participant()] : undefined}/>
        {chat.turns.at(-1)?.status === 'failed' && <button onClick={chat.retry}>Проверить прежнюю отправку</button>}</>;
}
beforeEach(() => {
    vi.clearAllMocks(); h.owner = 'alice'; h.caseId++; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    vi.stubGlobal('matchMedia',(media: string) => ({matches: false,media,addListener: vi.fn(),removeListener: vi.fn(),addEventListener: vi.fn(),removeEventListener: vi.fn()}));
    vi.mocked(agentToolsApi.capabilities).mockResolvedValue(structuredClone(cap)); vi.mocked(agentToolsApi.steps).mockResolvedValue([]);
    vi.mocked(modelChatApi.list).mockResolvedValue([]); vi.mocked(modelChatApi.read).mockResolvedValue(detail());
    vi.mocked(modelChatApi.send).mockImplementation(async (_detail,_model,requestId,prompt,_files,_signal,_targets,_research,grant) => detail({turns: [turn({requestId,prompt,agentTools: grant})]}));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => {root.unmount();});container.remove();vi.unstubAllGlobals();});
it('personal: defaults only read/help, pins first public model and requires explicit public consent before sending', async () => {
    await render(<Personal/>); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(modelChatApi.create).not.toHaveBeenCalled();
    expect(check('База знаний проекта').checked).toBe(true); expect(check('Системная справка и диагностика').checked).toBe(true); expect(container.textContent).toContain('До 3 дополнительных шагов');
    await type('#model-chat-message','Почему не работает RAG?'); await click(check('Поиск по публичным чатам проекта'));
    expect(container.textContent).toContain('Первая подходящая'); expect(button('Отправить').disabled).toBe(true);
    await click(check('Разрешаю передать запрос и публичные сообщения выбранной embedding-модели')); await click(button('Отправить'));
    expect(modelChatApi.send).toHaveBeenCalledOnce(); expect(vi.mocked(modelChatApi.send).mock.calls[0][8]).toEqual({...safe,publicChats: {modelId: 'embedding-one',expectedModelPin: 'a'.repeat(64),consent: true}});
    expect(check('Поиск по публичным чатам проекта').checked).toBe(false);
});
it('group: unknown submission retains the exact grant, recipients and request key after manual tools disable', async () => {
    vi.mocked(modelChatApi.send).mockRejectedValueOnce(Error('Unknown ACK')); vi.mocked(modelChatApi.read).mockRejectedValue(Error('offline'));
    await render(<Personal group/>); await type('#model-chat-message','@nc-developer проверь проект'); await click(button('Отправить'));
    const first = vi.mocked(modelChatApi.send).mock.calls[0]; expect(first[6]).toEqual(['agent-dev']); expect(first[8]).toEqual(safe);
    await click(check('Использовать контекст и инструменты')); await click(button('Проверить прежнюю отправку'));
    const replay = vi.mocked(modelChatApi.send).mock.calls[1]; expect(replay[2]).toBe(first[2]); expect(replay[6]).toEqual(first[6]); expect(replay[8]).toEqual(first[8]);
});
it('personal: unknown ACK preserves public consent for the exact replay, then clears it only after confirmed acceptance', async () => {
    vi.mocked(modelChatApi.send).mockRejectedValueOnce(Error('Unknown ACK')); vi.mocked(modelChatApi.read).mockRejectedValue(Error('offline'));
    await render(<Personal/>); await type('#model-chat-message','Найди публичное решение'); await click(check('Поиск по публичным чатам проекта')); await click(check('Разрешаю передать запрос и публичные сообщения выбранной embedding-модели')); await click(button('Отправить'));
    expect(check('Поиск по публичным чатам проекта').checked).toBe(true);
    await click(button('Проверить прежнюю отправку'));
    const calls = vi.mocked(modelChatApi.send).mock.calls; expect(calls[1][2]).toBe(calls[0][2]); expect(calls[1][8]).toEqual(calls[0][8]);
    expect(check('Поиск по публичным чатам проекта').checked).toBe(false);
});
it('team: feature OFF after unknown ACK does not replace the pending request key or grant on receipt replay', async () => {
    const send = vi.fn().mockRejectedValueOnce(Error('Network ACK lost')).mockResolvedValue({message: projectMessage(),roomRevision: 2});
    await render(<ProjectChatComposer draftKey={'team-' + h.caseId} detail={projectRoom()} onCancelReply={() => undefined} onSend={send}/>);
    await type('[aria-label="Текст сообщения команде"]','@developer объясни ошибку'); await click(button('Спросить агентов'));
    const first = send.mock.calls[0][0]; expect(first.agentTools).toEqual(safe); expect(first.targetAgentIds).toEqual(['developer']);
    vi.mocked(agentToolsApi.capabilities).mockResolvedValue({...cap,available: false,reason: 'OFF'}); await act(async () => {window.dispatchEvent(new Event('tools-test-flags'));}); await settle();
    await click(button('Проверить отправку')); expect(send.mock.calls[1][0]).toEqual(first); expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Текст сообщения команде"]')?.value).toBe('');
});
it('team: a late ACK from another owner leaves the current room draft intact', async () => {
    const pending = deferredSetup<ProjectChatReceipt>(),send = vi.fn().mockReturnValue(pending.promise);
    await render(<ProjectChatComposer key="alice" draftKey={'alice-' + h.caseId} detail={projectRoom()} onCancelReply={() => undefined} onSend={send}/>);
    await type('[aria-label="Текст сообщения команде"]','@developer первая задача'); await click(button('Спросить агентов'));
    h.owner = 'bob'; await render(<ProjectChatComposer key="bob" draftKey={'bob-' + h.caseId} detail={projectRoom()} onCancelReply={() => undefined} onSend={send}/>);
    await type('[aria-label="Текст сообщения команде"]','Новый текст Боба'); await act(async () => {pending.resolve({message: projectMessage(),roomRevision: 2});}); await settle();
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Текст сообщения команде"]')?.value).toBe('Новый текст Боба'); expect(send).toHaveBeenCalledOnce();
});
it('history: receipts including unknown outcomes stay readable without any model request or execution flag', async () => {
    vi.mocked(agentToolsApi.steps).mockResolvedValue([{id: 'step-one',turn_id: 'turn-one',recipient_id: 'response-one',agent_id: 'developer',model_id: 'chat-one',sequence: 1,action: 'request_system_role',state: 'unknown',error: null,reference: null,created_at: '',updated_at: ''}]);
    await render(<AgentToolHistory projectId="prj-one" turnId="turn-one" grant={safe}/>);
    expect(agentToolsApi.steps).not.toHaveBeenCalled(); expect(container.querySelector('.chat-activity > summary')?.textContent).toBe('Контекст и шаги инструментов');
    const outer = container.querySelector('details')!; await act(async () => {outer.open = true;outer.dispatchEvent(new Event('toggle'));}); await settle();
    expect(agentToolsApi.steps).toHaveBeenCalledWith('prj-one','turn-one',expect.any(AbortSignal)); expect(container.textContent).toContain('автоматический повтор закрыт'); expect(modelChatApi.send).not.toHaveBeenCalled();
});
it('keeps both research/tools choices and the draft until an explicit conflict resolution', async () => {
    function Conflict() {const tools = useAgentTools('conflict-' + h.caseId,'prj-one'),[research,setResearch] = useState(true);return <><textarea aria-label="Сохранённый текст" defaultValue="Мой вопрос"/><AgentToolsControls value={tools} projectId="prj-one" conflict={research && tools.draft.enabled} onUseTools={() => setResearch(false)} onUseResearch={tools.disable}/><span>{research ? 'Исследование включено' : 'Исследование выключено'}</span></>;}
    await render(<Conflict/>); expect(container.textContent).toContain('Текст и оба выбора сохранены'); expect(check('Использовать контекст и инструменты').checked).toBe(true);
    await click(button('Использовать инструменты агентов')); expect(container.textContent).toContain('Исследование выключено'); expect(check('База знаний проекта').checked).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Сохранённый текст"]')?.value).toBe('Мой вопрос'); expect(modelChatApi.send).not.toHaveBeenCalled();
});
it('does not inherit another project capability response or grant global chats a project context', async () => {
    const pending = deferredSetup<AgentToolCapabilities>(); vi.mocked(agentToolsApi.capabilities).mockImplementation(project => project === 'old-project' ? pending.promise : Promise.resolve({...cap,publicChats: {...cap.publicChats,models: [{...cap.publicChats.models[0],name: 'Модель нового проекта'}]}}));
    function Scope({project}: {project?: string}) {const tools = useAgentTools('scope-' + h.caseId,project);return <AgentToolsControls value={tools} projectId={project}/>;}
    await render(<Scope project="old-project"/>); await render(<Scope project="new-project"/>); await act(async () => {pending.resolve({...cap,publicChats: {...cap.publicChats,models: [{...cap.publicChats.models[0],name: 'Чужая старая модель'}]}});}); await settle();
    await click(check('Поиск по публичным чатам проекта')); expect(container.textContent).toContain('Модель нового проекта'); expect(container.textContent).not.toContain('Чужая старая модель');
    await render(<Scope/>); expect(check('Использовать контекст и инструменты').checked).toBe(false); expect(container.textContent).toContain('Выберите проект'); expect(modelChatApi.send).not.toHaveBeenCalled();
});
