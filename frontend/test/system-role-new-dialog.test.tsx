// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SystemRoleChat} from '../src/features/SystemRoleChat/SystemRoleChat';
import type {RoleOverview, RoleRun, SystemRoleId} from '../src/features/SystemRoles/types';
import type {ServiceTurn} from '../src/features/SystemRoleChat/types';
import {saveRoleModelPreference} from '../src/features/SystemRoleChat/roleModelPreference';

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
const overview = {definitions: [{id: 'agent-indexer', diagnostics: [], targets: []}, {id: 'agent-ai-admin', diagnostics: [], targets: []}], models: [model], targets: [], budget: {diagnostics: 5}} as unknown as RoleOverview;
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
const modelChoice = () => container.querySelector<HTMLSelectElement>('[aria-label="Модель чата роли"]')!;
const deferred = <T,>() => {let resolve!: (value: T) => void, reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const acknowledge = async (work: () => void) => {await act(async () => work());};
const prepareAndAccept = async () => {
    await click(button('Проверить контекст')); await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.startsWith('Отправить ·'))!);
};
beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = 'new-dialog-owner-' + ++sequence; sessionStorage.clear();
    vi.stubGlobal('matchMedia', (query: string) => ({matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    vi.mocked(systemRolesApi.overview).mockResolvedValue(overview);
    vi.mocked(api.list).mockResolvedValue([]); vi.mocked(api.create).mockResolvedValue(dialog); vi.mocked(api.read).mockResolvedValue({dialog, turns: []});
    vi.mocked(api.prepare).mockImplementation(async (_id, _agentId, selection) => ({selection, prepared: {preview: 'Own bounded context', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64), targets: []}}));
    vi.mocked(api.start).mockImplementation(async () => {vi.mocked(api.list).mockResolvedValue([dialog]); return turn;});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals();});

it.each(['overview', 'history'])('finishes initial loading after New with %s acknowledged first, keeping the preferred model and blank draft', async first => {
    const pendingOverview = deferred<RoleOverview>(), pendingHistory = deferred<typeof dialog[]>();
    const preferred = {...model, id: 'model-preferred', name: 'Preferred model'};
    saveRoleModelPreference(h.owner, 'prj-one', 'agent-ai-admin', preferred.id);
    vi.mocked(systemRolesApi.overview).mockReturnValueOnce(pendingOverview.promise);
    vi.mocked(api.list).mockReturnValueOnce(pendingHistory.promise);
    await render('agent-ai-admin'); expect(button('Новый диалог').disabled).toBe(false);
    expect(container.querySelector('.ant-spin-spinning')).not.toBeNull();
    await click(button('Новый диалог'));
    const acknowledgements = {overview: () => pendingOverview.resolve({...overview, models: [model, preferred]}), history: () => pendingHistory.resolve([dialog])};
    await acknowledge(acknowledgements[first as keyof typeof acknowledgements]);
    expect(container.querySelector('.ant-spin-spinning')).not.toBeNull();
    await acknowledge(acknowledgements[first === 'overview' ? 'history' : 'overview']);
    expect(container.querySelector('.ant-spin-spinning')).toBeNull();
    expect(button('Обновить').classList.contains('ant-btn-loading')).toBe(false);
    expect(history().value).toBe(''); expect(history().querySelector(`option[value="${dialog.id}"]`)).not.toBeNull();
    expect(modelChoice().value).toBe(preferred.id); expect(button('Проверить контекст').disabled).toBe(false);
    expect(systemRolesApi.overview).toHaveBeenCalledOnce(); expect(api.list).toHaveBeenCalledOnce(); expect(api.read).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled(); expect(api.prepare).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
    await act(async () => {history().value = dialog.id; history().dispatchEvent(new Event('change', {bubbles: true}));});
    expect(history().value).toBe(dialog.id); expect(api.read).toHaveBeenCalledExactlyOnceWith(dialog.id);
});

it('settles an in-flight refresh after New without restoring the previous dialogue detail', async () => {
    vi.mocked(api.list).mockResolvedValue([dialog]); vi.mocked(api.read).mockResolvedValue({dialog, turns: [turn]});
    await render(); expect(container.textContent).toContain('Own saved response');
    const pendingOverview = deferred<RoleOverview>(), pendingHistory = deferred<typeof dialog[]>(), pendingDetail = deferred<{dialog: typeof dialog; turns: ServiceTurn[]}>();
    vi.mocked(systemRolesApi.overview).mockReturnValueOnce(pendingOverview.promise);
    vi.mocked(api.list).mockReturnValueOnce(pendingHistory.promise); vi.mocked(api.read).mockReturnValueOnce(pendingDetail.promise);
    await click(button('Обновить')); await click(button('Новый диалог'));
    await acknowledge(() => {pendingOverview.resolve(overview); pendingHistory.resolve([dialog]);});
    expect(history().value).toBe(''); expect(container.textContent).not.toContain('Own saved response');
    await acknowledge(() => pendingDetail.resolve({dialog, turns: [turn]}));
    expect(history().value).toBe(''); expect(container.textContent).not.toContain('Own saved response');
    expect(modelChoice().value).toBe(model.id); expect(api.read).toHaveBeenCalledTimes(2);
    expect(api.create).not.toHaveBeenCalled(); expect(api.prepare).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it.each(['actor', 'project', 'role'])('ignores the old initial acknowledgements after New and a %s change', async change => {
    const pendingOverview = deferred<RoleOverview>(), pendingHistory = deferred<typeof dialog[]>();
    vi.mocked(systemRolesApi.overview).mockReturnValueOnce(pendingOverview.promise); vi.mocked(api.list).mockReturnValueOnce(pendingHistory.promise);
    await render(); await click(button('Новый диалог'));
    const nextModel = {...model, id: 'next-context-model'}, nextDialog = {...dialog, id: 'next-context-dialog', projectId: change === 'project' ? 'prj-two' : 'prj-one'};
    vi.mocked(systemRolesApi.overview).mockResolvedValue({...overview, models: [nextModel]});
    vi.mocked(api.list).mockResolvedValue([nextDialog]); vi.mocked(api.read).mockResolvedValue({dialog: nextDialog, turns: []});
    if (change === 'actor') h.owner = 'other-person-' + sequence;
    await render(change === 'role' ? 'agent-ai-admin' : 'agent-indexer', nextDialog.projectId);
    await acknowledge(() => {pendingOverview.resolve(overview); pendingHistory.resolve([dialog]);});
    expect(history().value).toBe(nextDialog.id); expect(modelChoice().value).toBe(nextModel.id);
    expect(modelChoice().querySelector(`option[value="${model.id}"]`)).toBeNull();
    expect(container.querySelector('.ant-spin-spinning')).toBeNull(); expect(api.read).toHaveBeenCalledExactlyOnceWith(nextDialog.id);
    expect(api.create).not.toHaveBeenCalled(); expect(api.prepare).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it('clears initial loading after New when overview fails and recovers through explicit refresh without reopening history', async () => {
    const pendingOverview = deferred<RoleOverview>(), pendingHistory = deferred<typeof dialog[]>();
    vi.mocked(systemRolesApi.overview).mockReturnValueOnce(pendingOverview.promise); vi.mocked(api.list).mockReturnValueOnce(pendingHistory.promise);
    await render(); await click(button('Новый диалог'));
    await acknowledge(() => {pendingOverview.reject(Error('Read unavailable')); pendingHistory.resolve([dialog]);});
    expect(container.querySelector('.ant-spin-spinning')).toBeNull(); expect(container.textContent).toContain('Часть данных не обновилась');
    await click(button('Обновить'));
    expect(container.textContent).not.toContain('Часть данных не обновилась'); expect(history().value).toBe(''); expect(modelChoice().value).toBe(model.id);
    expect(api.read).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled(); expect(api.prepare).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

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
