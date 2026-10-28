// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ServiceTurnContent} from '../src/features/SystemRoleChat/ServiceTurnContent';
import type {RoleRun} from '../src/features/SystemRoles/types';
import type {ServiceTurn} from '../src/features/SystemRoleChat/types';

const h = vi.hoisted(() => ({scope: 'owner-one', enabled: false}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    const scope = h.scope; return {scope, captureOwner: () => () => scope === h.scope};
}}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: h.enabled, reason: 'Функция выключена'})}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn()}}));
import api from '../src/core/api/base';

const run = {id: '9525de45-cef2-4f05-8555-169d7fa25f1b', agentId: 'agent-ai-admin', projectId: 'prj-one', actor: 'owner-one', state: 'succeeded', phase: 'completed',
    revision: 1, operationId: 'system-role-9525de45-cef2-4f05-8555-169d7fa25f1b', message: 'Ответ роли сохранён.', createdAt: '2026-10-28T00:00:00Z', finishedAt: '2026-10-28T00:00:01Z',
    callsStarted: 2, modelId: 'model-one', modelPin: 'a'.repeat(64), facts: [], result: null, steps: [], applied: [], targets: [], canApply: false, canRollback: false, canCancel: false} satisfies RoleRun;
const receipt = {id: 'b9d82b95-c1d8-4dad-9c4d-ab231214cfe0', toolKey: 'b'.repeat(64), name: 'echo', state: 'succeeded', message: 'Инструмент вернул результат.',
    at: '2026-10-28T00:00:01Z', output: {text: 'Actual saved MCP output', isError: false, truncated: false}};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
let root: Root, container: HTMLDivElement;
const settle = async () => {await act(async () => {await Promise.resolve();});};
const render = async (current: RoleRun = run) => {
    const turn: ServiceTurn = {id: 'turn-one', agentId: current.agentId, instruction: 'Own selected tool task', createdAt: current.createdAt, cancelRequested: false, run: current};
    await act(async () => root.render(createElement(ServiceTurnContent, {turn, busy: false, onAction: vi.fn()})));
};
const panel = () => [...container.querySelectorAll('details')].find(node => node.querySelector(':scope > summary')?.textContent === 'Результаты MCP');
const read = async () => {
    expect(panel(), 'Saved role history must expose its MCP receipts').toBeTruthy();
    panel()!.open = true;
    const button = panel()!.querySelector<HTMLButtonElement>('button')!;
    await act(async () => button.click()); await settle();
};
beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.scope = 'owner-one'; h.enabled = false;
    vi.stubGlobal('matchMedia', (media: string) => ({matches: false, media, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    vi.mocked(api.get).mockResolvedValue({data: [receipt]});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

it('reads the actual saved MCP output and receipt UUID from role history while new calls are OFF', async () => {
    await render(); expect(api.get).not.toHaveBeenCalled();
    expect(panel()?.open).toBe(false); await read();
    expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/system-role-mcp/runs/' + run.id + '/calls');
    expect(panel()!.textContent).toContain(receipt.output.text); expect(panel()!.textContent).toContain(receipt.id);
    expect(container.textContent).toContain(run.message); expect(api.post).not.toHaveBeenCalled();
});

it.each(['unknown', 'cancelled'] as const)('shows a saved late output without promoting the %s outcome or repeating it', async state => {
    vi.mocked(api.get).mockResolvedValue({data: [{...receipt, state, message: 'Поздний ответ сохранён отдельно. Состояние задачи не изменено.'}]});
    await render({...run, state: 'cancelled', phase: 'cancelled'}); await read();
    expect(panel()!.textContent).toContain(state === 'unknown' ? 'Исход не подтверждён' : 'Вызов отменён');
    expect(panel()!.textContent).toContain('Поздний ответ сохранён отдельно. Состояние задачи не изменено.');
    expect(panel()!.textContent).toContain(receipt.output.text); expect(panel()!.querySelector('.ant-tag-success')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
});

it.each([['failed', 'Вызов не завершён'], ['unknown', 'Исход не подтверждён'], ['cancelled', 'Вызов отменён']])('keeps %s without inventing an absent tool output', async (state, label) => {
    const {output: _output, ...withoutOutput} = receipt;
    vi.mocked(api.get).mockResolvedValue({data: [{...withoutOutput, state, message: 'Сохранённое состояние вызова.'}]});
    await render(); await read();
    expect(panel()!.textContent).toContain(label); expect(panel()!.textContent).toContain('Сохранённого ответа инструмента нет.');
    expect(panel()!.textContent).not.toContain(receipt.output.text); expect(api.post).not.toHaveBeenCalled();
});

it('renders error, truncation and structured output as escaped text without executable HTML or links', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script> javascript:alert(3)';
    vi.mocked(api.get).mockResolvedValue({data: [{...receipt, name: hostile, output: {text: hostile, isError: true, truncated: true, structuredContent: {saved: hostile}}}]});
    await render(); await read();
    expect(panel()!.textContent).toContain('Инструмент сообщил об ошибке.'); expect(panel()!.textContent).toContain('Ответ сокращён при сохранении.');
    expect(panel()!.textContent).toContain(hostile); expect(panel()!.querySelector('img, script, iframe, a')).toBeNull();
    expect(panel()!.querySelector('.ant-tag-success')).toBeNull();
    const output = [...panel()!.querySelectorAll('pre')]; expect(output[0].textContent).toBe(hostile); expect(output[1].textContent).toContain('"saved"');
    expect(api.post).not.toHaveBeenCalled();
});

it('shows bounded loading, ignores a duplicate read and offers the same GET after a read error', async () => {
    const pending = deferred<{data: typeof receipt[]}>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise);
    await render(); await read();
    expect(panel()!.querySelector('[role="status"]')?.textContent).toBe('Читаем квитанции MCP…');
    expect(panel()!.querySelector('button')!.disabled).toBe(true); await read(); expect(api.get).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({data: [receipt]}));
    vi.mocked(api.get).mockRejectedValueOnce(Error('Журнал временно недоступен'));
    await read(); expect(panel()!.textContent).toContain('Журнал временно недоступен');
    expect(container.textContent).toContain(run.message); expect(panel()!.textContent).not.toContain(receipt.output.text);
    await read(); expect(panel()!.textContent).toContain(receipt.output.text);
    expect(api.get).toHaveBeenCalledTimes(3);
    for (const args of vi.mocked(api.get).mock.calls) expect(args).toEqual(['/api/system-role-mcp/runs/' + run.id + '/calls']);
    expect(api.post).not.toHaveBeenCalled();
});

it('keeps an empty journal explicit and reads saved history again only on request after remount', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({data: []}); await render(); await read();
    expect(panel()!.textContent).toContain('Вызовов MCP в этом запуске нет.');
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(panel()!.open).toBe(false); expect(panel()!.textContent).not.toContain(receipt.output.text); expect(api.get).toHaveBeenCalledOnce();
    await read(); expect(panel()!.textContent).toContain(receipt.output.text); expect(api.get).toHaveBeenCalledTimes(2); expect(api.post).not.toHaveBeenCalled();
});

it('retains already loaded history and read-only refresh when execution is switched OFF', async () => {
    h.enabled = true; await render(); await read(); h.enabled = false; await render();
    expect(panel()!.textContent).toContain(receipt.output.text); expect(api.get).toHaveBeenCalledOnce();
    await read(); expect(api.get).toHaveBeenCalledTimes(2); expect(api.post).not.toHaveBeenCalled();
});

it('does not carry an unresolved receipt into a fresh mount', async () => {
    const old = deferred<{data: typeof receipt[]}>(); vi.mocked(api.get).mockReturnValueOnce(old.promise);
    await render(); await read(); await act(async () => root.unmount()); root = createRoot(container); await render();
    await act(async () => old.resolve({data: [receipt]}));
    expect(panel()!.textContent).not.toContain(receipt.output.text); expect(api.get).toHaveBeenCalledOnce();
    await read(); expect(panel()!.textContent).toContain(receipt.output.text); expect(api.post).not.toHaveBeenCalled();
});

it.each(['actor', 'rights', 'project', 'role', 'run'])('discards late receipts across a %s change, including a return to the original context', async change => {
    const old = deferred<{data: typeof receipt[]}>(); vi.mocked(api.get).mockReturnValueOnce(old.promise);
    await render(); await read();
    if (change === 'actor' || change === 'rights') h.scope = change + '-changed';
    const next: RoleRun = {...run, ...(change === 'project' ? {projectId: 'prj-two'} : change === 'role' ? {agentId: 'agent-coordinator'} : change === 'run' ? {id: '7d83e25f-c6bb-4c04-a813-e5d2f0c17fef'} : {})};
    await render(next); expect(panel()!.textContent).not.toContain(receipt.output.text);
    const currentOutput = {...receipt, output: {...receipt.output, text: 'Current context receipt'}};
    vi.mocked(api.get).mockResolvedValue({data: [currentOutput]}); await read();
    expect(panel()!.textContent).toContain('Current context receipt');
    h.scope = 'owner-one'; await render();
    expect(panel()!.textContent).not.toContain('Current context receipt');
    await act(async () => old.resolve({data: [receipt]}));
    expect(panel()!.textContent).not.toContain(receipt.output.text); expect(panel()!.textContent).not.toContain(receipt.id);
    await read(); expect(panel()!.textContent).toContain('Current context receipt'); expect(api.post).not.toHaveBeenCalled();
});

it('hides previously loaded receipts on owner change and checks current ownership even before rerender', async () => {
    await render(); await read(); expect(panel()!.textContent).toContain(receipt.id);
    h.scope = 'other-owner'; await read(); expect(api.get).toHaveBeenCalledOnce();
    await render(); expect(panel()!.textContent).not.toContain(receipt.id); expect(panel()!.textContent).not.toContain(receipt.output.text);
    expect(api.post).not.toHaveBeenCalled();
});
