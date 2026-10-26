// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { IOperationPage } from '../src/core/api/interfaces';
import type { IUserBlockState } from '../src/features/UserBlock/interfaces';
import OperationsButton from '../src/modules/Operations/OperationsButton';
import type { RootState } from '../src/store';

const h = vi.hoisted(() => ({ read: vi.fn(), refresh: undefined as (() => void) | undefined, userBlock: {} as IUserBlockState }));
vi.mock('../src/core/api/bff', () => ({ default: { listOperations: () => h.read() } }));
vi.mock('react-redux', () => ({ useSelector: (select: (state: RootState) => unknown) => select({ userBlock: h.userBlock } as RootState) }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: (_sections: unknown, refresh: () => void) => { h.refresh = refresh; } }));
vi.mock('@ant-design/icons', () => ({ ScheduleOutlined: () => null, WarningOutlined: () => null }));
vi.mock('antd', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
    Badge: ({ children }: { children: ReactNode }) => children,
    Button: ({ children, icon: _icon, ...props }: { children: ReactNode; icon: ReactNode }) => createElement('button', props, children),
}));

const page = (activeCount = 0): IOperationPage => ({ items: [], page: 1, size: 1, total: 0, activeCount });
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}
let root: Root, container: HTMLDivElement;
const render = async () => { await act(async () => { root.render(createElement(OperationsButton, { open: false, onClick: () => undefined })); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const status = () => container.querySelector('[role="status"]')?.textContent;

beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    h.userBlock = { isAuth: true, processing: false, error: '', authorizationUnconfirmed: false, request: null, policies: {},
        user: { id: 'alice', principalName: 'alice', email: 'alice@example.test', displayName: 'Alice', activeRole: 'Администратор',
            userRoles: ['Администратор'], routePermissions: [], projectRoles: [] } };
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => { root.unmount(); }); container.remove(); Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers(); vi.unstubAllGlobals();
});

it('до первой сводки сообщает об ожидании, а медленные 503 не теряются на следующем тике', async () => {
    h.read.mockImplementation(() => new Promise<IOperationPage>((_resolve, reject) => { setTimeout(() => reject(new Error('HTTP 503')), 18000); }));
    await render();
    expect(status()).toContain('Проверяем активные операции');
    await advance(15000);
    expect(h.read).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(status()).toContain('Не удалось обновить операции');
    expect(status()).not.toContain('последние полученные данные');
    await advance(12000);
    expect(h.read).toHaveBeenCalledTimes(2);
    h.read.mockResolvedValueOnce(page());
    await advance(30000);
    expect(status()).toContain('Нет активных операций');
});

it('частые socket и visibility обновления ждут текущую сводку, затем сохраняют ее при отказе', async () => {
    const pending = deferred<IOperationPage>(); h.read.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('HTTP 503'));
    await render();
    await act(async () => { h.refresh?.(); document.dispatchEvent(new Event('visibilitychange')); });
    await advance(15000); expect(h.read).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(page(4)); });
    expect(status()).toContain('Активных операций: 4');
    await advance(5000);
    expect(status()).toContain('Показаны последние полученные данные');
});

it('смена роли сразу скрывает прежний результат и не принимает его запоздалый ACK', async () => {
    const old = deferred<IOperationPage>(), current = deferred<IOperationPage>();
    h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render();
    h.userBlock = { ...h.userBlock, user: { ...h.userBlock.user!, activeRole: 'Наблюдатель' } }; await render();
    expect(h.read).toHaveBeenCalledTimes(2); expect(status()).toContain('Проверяем активные операции');
    await act(async () => { current.resolve(page()); old.resolve(page(99)); });
    expect(status()).toContain('Нет активных операций'); expect(status()).not.toContain('99');
});

it('выход и unmount прекращают polling и не возвращают данные позднего ответа', async () => {
    const pending = deferred<IOperationPage>(); h.read.mockReturnValue(pending.promise);
    await render(); h.userBlock = { ...h.userBlock, isAuth: false, user: null }; await render();
    await act(async () => { pending.resolve(page(99)); }); await advance(60000);
    expect(h.read).toHaveBeenCalledTimes(1); expect(status()).not.toContain('99');
});
