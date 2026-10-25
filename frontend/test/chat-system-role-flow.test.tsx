// @vitest-environment jsdom
import {act, createElement, StrictMode, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SystemRoleChat} from '../src/features/SystemRoleChat/SystemRoleChat';
import type {ServiceTurn} from '../src/features/SystemRoleChat/types';
import type {RoleOverview, RoleRun} from '../src/features/SystemRoles/types';
import type {ChatRoleLaunch} from '../src/features/ChatSystemRoles/types';
import {deferredSetup} from './admin-setup-hooks.fixture';
import {useChatRoleAction} from '../src/features/ChatSystemRoles/useChatRoleAction';
import {ChatSendAction} from '../src/features/ChatCommon/ChatSendAction';

const h = vi.hoisted(() => ({owner: 'alice', bound: false, accepted: vi.fn(), capture: () => {const owner = h.owner; return () => owner === h.owner;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.owner, captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: true, reason: ''})}));
vi.mock('../src/features/SystemRoleChat/McpTaskPicker', () => ({McpTaskPicker: () => null}));
vi.mock('../src/features/SystemRoles/IndexerOwnerActions', () => ({IndexerOwnerActions: () => null}));
vi.mock('../src/features/SystemRoles/api', () => ({systemRolesApi: {overview: vi.fn(), action: vi.fn()}}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn()}}));
vi.mock('../src/features/SystemRoleChat/api', () => ({systemRoleChatsApi: {list: vi.fn(), create: vi.fn(), read: vi.fn(), prepare: vi.fn(), start: vi.fn(), request: vi.fn(), cancel: vi.fn()}}));
import base from '../src/core/api/base';
import {systemRolesApi} from '../src/features/SystemRoles/api';
import {systemRoleChatsApi as api} from '../src/features/SystemRoleChat/api';

const origin = {kind: 'project-chat' as const, originId: '00000000-0000-0000-0000-000000000000', projectId: 'prj-one'};
const dialog = {id: '27172bcb-bb2d-4c16-a48c-ce9247cec33e', projectId: 'prj-one', title: 'Системные задачи', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z'};
const model = {id: 'model-one', name: 'Проверенная модель', pin: 'a'.repeat(64)};
const launch: ChatRoleLaunch = {key: 1, origin: JSON.stringify(['project-chat', origin.originId, origin.projectId]), agentId: 'agent-indexer', instruction: 'Почему не работает RAG?', modelId: model.id, onAccepted: h.accepted};
const run = {id: 'run-one', agentId: 'agent-indexer', projectId: 'prj-one', state: 'succeeded', phase: 'succeeded', revision: 1, canCancel: false, canApply: false, canRollback: false,
    modelId: model.id, facts: [], targets: [], steps: [], applied: [], result: {kind: 'diagnosis', summary: 'Индекс требует настройки модели.', findings: [], nextSteps: [], changes: []}} as unknown as RoleRun;
const turn: ServiceTurn = {id: 'request-one', agentId: 'agent-indexer', instruction: launch.instruction, createdAt: dialog.createdAt, cancelRequested: false, run};
let root: Root, container: HTMLDivElement;
const settle = async () => {await act(async () => {await new Promise(done => setTimeout(done, 10));});};
function Host({task}: {task?: ChatRoleLaunch}) {
    const [body,setBody] = useState(task?.instruction ?? ''), [done,setDone] = useState(false);
    const active = task && !done, controls = useChatRoleAction(active ? task.origin + ':' + task.key : undefined);
    return <><SystemRoleChat embedded projectId="prj-one" origin={origin} launch={active ? {...task,instruction: body,onAccepted: accepted => {h.accepted(accepted); setDone(true); setBody(current => current === accepted ? '' : current);}} : undefined} onActionChange={controls.register}/>
        <textarea aria-label="Сообщение" value={body} onChange={event => setBody(event.target.value)}/>
        <ChatSendAction task={controls.action} disabled onSend={() => undefined}/></>;
}
const render = async (task?: ChatRoleLaunch) => {await act(async () => {root.render(createElement(StrictMode,null,createElement(Host,{task})));}); await settle();};
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const click = async (node: HTMLElement) => {expect(node).toBeTruthy(); await act(async () => {node.click();}); await settle();};
const typeBody = async (body: string) => {await act(async () => {
    const node = container.querySelector<HTMLTextAreaElement>('[aria-label="Сообщение"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(node,body);
    node.dispatchEvent(new Event('input',{bubbles: true}));
}); await settle();};
beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = 'alice'; h.bound = false; sessionStorage.clear();
    vi.stubGlobal('matchMedia', (query: string) => ({matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    vi.mocked(systemRolesApi.overview).mockResolvedValue({definitions: [{id: 'agent-indexer', diagnostics: [], targets: []}], models: [model], targets: [], budget: {diagnostics: 5}} as unknown as RoleOverview);
    vi.mocked(base.get).mockImplementation(async () => ({data: h.bound ? dialog : null}) as never);
    vi.mocked(base.post).mockImplementation(async () => {h.bound = true; return {data: dialog} as never;});
    vi.mocked(api.read).mockResolvedValue({dialog, turns: []});
    vi.mocked(api.prepare).mockImplementation(async (_id, _agentId, selection) => ({selection, prepared: {preview: 'Показана только явно выбранная задача.', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64), targets: []}}));
    vi.mocked(api.start).mockResolvedValue(turn); vi.mocked(api.request).mockResolvedValue(turn);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => {root.unmount();}); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals();});

it('uses a compact task and canonical binding, then requires consent before any inference', async () => {
    await render(launch);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Сообщение"]')?.value).toBe(launch.instruction);
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(container.querySelector('.service-chat__heading')).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>('.service-chat__context')?.open).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>('.service-chat__task-settings')?.open).toBe(false);
    expect(api.start).not.toHaveBeenCalled(); await click(button('Проверить контекст'));
    expect(base.post).toHaveBeenCalledExactlyOnceWith('/api/chat-system-roles/origin', origin);
    expect(api.prepare).toHaveBeenCalledWith(dialog.id, 'agent-indexer', expect.objectContaining({instruction: launch.instruction, targets: []}), false);
    expect(button('Проверить контекст')).toBeUndefined(); expect(button('Отправить задачу').disabled).toBe(true);
    expect(container.querySelectorAll('button.ant-btn-primary')).toHaveLength(1);
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const pending = deferredSetup<ServiceTurn>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise);
    await click(button('Отправить задачу')); expect(h.accepted).not.toHaveBeenCalled();
    vi.mocked(api.read).mockResolvedValue({dialog, turns: [turn]});
    await act(async () => {pending.resolve(turn);}); await settle();
    expect(h.accepted).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Индекс требует настройки модели.');
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Сообщение"]')?.value).toBe('');
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
});

it('a failed free preview keeps the complete task and permits an explicit retry without starting a model', async () => {
    vi.mocked(api.prepare).mockRejectedValueOnce(Error('Dependency unavailable')); await render(launch);
    await click(button('Проверить контекст'));
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Сообщение"]')?.value).toBe(launch.instruction);
    expect(button('Проверить контекст').disabled).toBe(false); expect(api.start).not.toHaveBeenCalled();
    await click(button('Проверить контекст')); expect(api.prepare).toHaveBeenCalledTimes(2); expect(base.post).toHaveBeenCalledOnce();
});

it('a failed automatic history read does not spin; the user can retry the same private binding', async () => {
    h.bound = true; vi.mocked(api.read).mockRejectedValue(Error('History unavailable')); await render();
    await settle(); await settle(); expect(api.read).toHaveBeenCalledOnce();
    vi.mocked(api.read).mockResolvedValue({dialog, turns: [turn]}); await click(button('Повторить проверку'));
    expect(api.read).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('Индекс требует настройки модели.'); expect(api.start).not.toHaveBeenCalled();
});
it('editing the common draft invalidates consent and sends the new exact instruction only after a new preview', async () => {
    await render(launch); await click(button('Проверить контекст'));
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await typeBody('Проверь новую задачу без изменения настроек.');
    expect(button('Отправить задачу')).toBeUndefined(); expect(button('Проверить контекст').disabled).toBe(false);
    await click(button('Проверить контекст'));
    expect(api.prepare).toHaveBeenLastCalledWith(dialog.id,'agent-indexer',expect.objectContaining({instruction: 'Проверь новую задачу без изменения настроек.'}),false);
    expect(button('Отправить задачу').disabled).toBe(true); expect(api.start).not.toHaveBeenCalled(); expect(container.querySelectorAll('textarea')).toHaveLength(1);
});
it('retains a newer common draft after a delayed accepted task and does not repeat its model call', async () => {
    await render(launch); await click(button('Проверить контекст')); await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const pending = deferredSetup<ServiceTurn>(); vi.mocked(api.start).mockReturnValueOnce(pending.promise); await click(button('Отправить задачу'));
    await typeBody('Новый вопрос после отправки.'); await act(async () => {pending.resolve(turn);}); await settle();
    expect(api.start).toHaveBeenCalledOnce(); expect(h.accepted).toHaveBeenCalledWith(turn.instruction);
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Сообщение"]')?.value).toBe('Новый вопрос после отправки.');
});
