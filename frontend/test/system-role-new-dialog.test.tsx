// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SystemRoleChat} from '../src/features/SystemRoleChat/SystemRoleChat';
import type {RoleOverview, RoleRun, SystemRoleId} from '../src/features/SystemRoles/types';
import type {ServiceTurn} from '../src/features/SystemRoleChat/types';

const h = vi.hoisted(() => ({owner: '', capture: () => {const owner = h.owner; return () => owner === h.owner;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.owner, captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: true, reason: ''})}));
vi.mock('../src/features/SystemRoleChat/McpTaskPicker', () => ({McpTaskPicker: () => null}));
vi.mock('../src/features/SystemRoles/IndexerOwnerActions', () => ({IndexerOwnerActions: () => null}));
vi.mock('../src/features/SystemRoles/api', () => ({systemRolesApi: {overview: vi.fn(), action: vi.fn()}}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn()}}));
vi.mock('../src/features/SystemRoleChat/api', () => {
    const transport = {list: vi.fn(), create: vi.fn(), read: vi.fn(), prepare: vi.fn(), start: vi.fn(), request: vi.fn(), cancel: vi.fn()};
    return {systemRoleChatsApi: transport, roleConversationApi: () => transport};
});
vi.mock('antd', async original => {
    const actual = await original<typeof import('antd')>(), {createElement: element} = await import('react');
    return {...actual, Select: ({value, options = [], onChange, disabled, 'aria-label': label}: any) => element('select', {value: value ?? '', disabled, 'aria-label': label, onChange: (event: any) => onChange(event.target.value)},
        element('option', {value: ''}, 'Выберите'), ...options.map((item: any) => element('option', {key: item.value, value: item.value}, item.label)))};
});
import {systemRolesApi} from '../src/features/SystemRoles/api';
import {systemRoleChatsApi as api} from '../src/features/SystemRoleChat/api';

const dialog = {id: '27172bcb-bb2d-4c16-a48c-ce9247cec33e', projectId: 'prj-one', title: 'Existing task', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z'};
const model = {id: 'model-one', name: 'Own model', pin: 'a'.repeat(64)};
const run = {id: 'run-one', agentId: 'agent-indexer', projectId: 'prj-one', state: 'succeeded', phase: 'succeeded', revision: 1, canCancel: false, canApply: false, canRollback: false,
    modelId: model.id, facts: [], targets: [], steps: [], applied: [], result: {kind: 'diagnosis', summary: 'Own saved response', findings: [], nextSteps: [], changes: []}} as unknown as RoleRun;
const turn: ServiceTurn = {id: 'request-one', agentId: 'agent-indexer', instruction: 'Own task', createdAt: dialog.createdAt, cancelRequested: false, run};
let root: Root, container: HTMLDivElement, sequence = 0;
const settle = async () => {await act(async () => {await new Promise(done => setTimeout(done, 5));});};
const render = async (agentId: SystemRoleId = 'agent-indexer', projectId = 'prj-one') => {
    await act(async () => {root.render(createElement(SystemRoleChat, {agentId, projectId, initialInstruction: 'Own task'}));}); await settle();
};
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const click = async (node: HTMLElement) => {expect(node).toBeTruthy(); await act(async () => node.click()); await settle();};
const history = () => container.querySelector<HTMLSelectElement>('[aria-label^="История ·"]')!;
const prepareAndAccept = async () => {
    await click(button('Проверить контекст')); await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.startsWith('Отправить ·'))!);
};
beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = 'new-dialog-owner-' + ++sequence; sessionStorage.clear();
    vi.stubGlobal('matchMedia', (query: string) => ({matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    vi.mocked(systemRolesApi.overview).mockResolvedValue({definitions: [{id: 'agent-indexer', diagnostics: [], targets: []}, {id: 'agent-ai-admin', diagnostics: [], targets: []}], models: [model], targets: [], budget: {diagnostics: 5}} as unknown as RoleOverview);
    vi.mocked(api.list).mockResolvedValue([]); vi.mocked(api.create).mockResolvedValue(dialog); vi.mocked(api.read).mockResolvedValue({dialog, turns: []});
    vi.mocked(api.prepare).mockImplementation(async (_id, _agentId, selection) => ({selection, prepared: {preview: 'Own bounded context', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64), targets: []}}));
    vi.mocked(api.start).mockImplementation(async () => {vi.mocked(api.list).mockResolvedValue([dialog]); return turn;});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals();});

it('keeps an explicit new dialogue after creating the first dialogue in this mount', async () => {
    await render(); await prepareAndAccept();
    const reads = vi.mocked(api.read).mock.calls.length;
    await click(button('Новый диалог'));
    expect(api.read).toHaveBeenCalledTimes(reads); expect(history().value).toBe('');
    expect(api.start).toHaveBeenCalledOnce();
});

it('does not replace a new blank draft when refresh returns a different first historical dialogue', async () => {
    vi.mocked(api.list).mockResolvedValue([dialog]); await render(); expect(history().value).toBe(dialog.id);
    await click(button('Новый диалог')); const reads = vi.mocked(api.read).mock.calls.length;
    vi.mocked(api.list).mockResolvedValue([{...dialog, id: 'changed-first', title: 'Other-tab task'}]);
    await click(button('Обновить'));
    expect(history().value).toBe(''); expect(api.read).toHaveBeenCalledTimes(reads);
    expect(api.create).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it('allows explicit historical selection after New and prepares the next blank task with a new dialogue ID', async () => {
    vi.mocked(api.list).mockResolvedValue([dialog]); await render(); await click(button('Новый диалог'));
    await act(async () => {history().value = dialog.id; history().dispatchEvent(new Event('change', {bubbles: true}));}); await settle();
    expect(history().value).toBe(dialog.id);
    await click(button('Новый диалог'));
    vi.mocked(api.create).mockImplementation(async input => ({...dialog, ...input}));
    await click(button('Проверить контекст'));
    const created = vi.mocked(api.create).mock.calls[0][0];
    expect(created.id).not.toBe(dialog.id); expect(created.agentId).toBe('agent-indexer');
    expect(api.prepare).toHaveBeenCalledOnce(); expect(api.start).not.toHaveBeenCalled();
});

it.each(['actor', 'project', 'role'])('retains default automatic history on initial open and after a %s change', async change => {
    vi.mocked(api.list).mockResolvedValue([dialog]); await render(); expect(history().value).toBe(dialog.id);
    await click(button('Новый диалог')); expect(history().value).toBe('');
    const next = {...dialog, id: 'next-context-dialog', projectId: change === 'project' ? 'prj-two' : 'prj-one'};
    vi.mocked(api.list).mockResolvedValue([next]); vi.mocked(api.read).mockResolvedValue({dialog: next, turns: []});
    if (change === 'actor') h.owner = 'other-person-' + sequence;
    await render(change === 'role' ? 'agent-ai-admin' : 'agent-indexer', next.projectId);
    expect(history().value).toBe(next.id); expect(api.start).not.toHaveBeenCalled();
});

it('keeps pending request recovery available and blocks New until the original request is acknowledged', async () => {
    vi.mocked(api.start).mockRejectedValueOnce(Error('ACK lost'));
    await render(); await prepareAndAccept(); expect(button('Новый диалог').disabled).toBe(true);
    const input = vi.mocked(api.start).mock.calls[0][2], accepted = {...turn, id: input.requestId};
    vi.mocked(api.request).mockResolvedValue(accepted); vi.mocked(api.read).mockResolvedValue({dialog, turns: [accepted]});
    await click(button('Проверить отправку'));
    expect(api.request).toHaveBeenCalledWith(dialog.id, input.requestId); expect(button('Новый диалог').disabled).toBe(false);
    expect(api.start).toHaveBeenCalledOnce();
});
