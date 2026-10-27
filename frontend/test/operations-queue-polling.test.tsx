// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { IOperationDetail, IOperationPage } from '../src/core/api/interfaces';
import type { IUserBlockState } from '../src/features/UserBlock/interfaces';
import { useOperationsQueue } from '../src/modules/Operations/useOperationsQueue';
import type { RootState } from '../src/store';

const h = vi.hoisted(() => ({ read: vi.fn(), detail: vi.fn(), refresh: undefined as (() => void) | undefined,
    userBlock: {} as IUserBlockState }));
vi.mock('../src/core/api/bff', () => ({ default: { listOperations: (...args: unknown[]) => h.read(...args), getOperation: (...args: unknown[]) => h.detail(...args) } }));
vi.mock('react-redux', () => ({ useSelector: (select: (state: RootState) => unknown) => select({ userBlock: h.userBlock } as RootState) }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: (_sections: unknown, refresh: () => void) => { h.refresh = refresh; } }));
vi.mock('../src/features/TabNotifications/useTabWatch', () => ({ useTabWatch: () => undefined }));

let queue: ReturnType<typeof useOperationsQueue>;
function Probe() { queue = useOperationsQueue(); return createElement('span', null, queue.error || queue.detailError); }
let root: Root, container: HTMLDivElement;
const render = async () => { await act(async () => { root.render(createElement(Probe)); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const page: IOperationPage = { items: [], page: 1, size: 10, total: 0, activeCount: 0 };

beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    h.userBlock = { isAuth: true, processing: false, error: '', authorizationUnconfirmed: false, request: null, policies: {},
        user: { id: 'qa', principalName: 'qa', email: 'qa@example.test', displayName: 'QA', activeRole: 'Наблюдатель',
            userRoles: ['Наблюдатель'], routePermissions: [], projectRoles: [] } };
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
    await act(async () => { root.unmount(); }); container.remove(); Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers(); vi.unstubAllGlobals();
});

it('медленный отказ списка переживает polling, socket и visibility, после чего доступен явный повтор', async () => {
    h.read.mockImplementation(() => new Promise<IOperationPage>((_resolve, reject) => {
        setTimeout(() => reject(new Error('HTTP 503')), 18000);
    }));
    await render();
    await act(async () => { h.refresh?.(); document.dispatchEvent(new Event('visibilitychange')); });
    await advance(15000);
    expect(h.read).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(queue.error).toBe('HTTP 503'); expect(queue.loading).toBe(false);
    h.read.mockResolvedValueOnce(page);
    await act(async () => { await queue.reload(); });
    expect(queue.error).toBe(''); expect(queue.updatedAt).toEqual(expect.any(String));
});

it('медленный отказ подробностей не теряется между фоновыми обновлениями', async () => {
    h.read.mockResolvedValue(page);
    h.detail.mockImplementation(() => new Promise<IOperationDetail>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Журнал недоступен')), 18000);
    }));
    await render();
    await act(async () => { void queue.select('own-operation'); });
    await advance(15000);
    expect(h.detail).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(queue.detailError).toBe('Журнал недоступен'); expect(queue.detailLoading).toBe(false);
});
