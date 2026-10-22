import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from 'antd';
import { bridgeApi, type IInstallPlan } from '../src/features/McpBridge/api';
import type { IStoreApp } from '../src/features/Catalog/types';
import { useInstallPlan } from '../src/modules/Store/installPlans/useInstallPlan';

const hooks = vi.hoisted(() => ({
    cursor: 0,
    slots: [] as Array<{ value?: unknown; current?: unknown; dependencies?: unknown[]; cleanup?: (() => void) | void }>,
    effects: [] as Array<() => void>,
}));
// Контролируем жизненный цикл без браузера: повторный рендер читает настоящие переходы состояния хука.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: <T,>(initial: T) => {
        const index = hooks.cursor++;
        const slot = hooks.slots[index] ??= { value: initial };
        return [slot.value as T, (next: T | ((previous: T) => T)) => {
            slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next;
        }];
    },
    useRef: (initial: unknown) => hooks.slots[hooks.cursor++] ??= { current: initial },
    useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
        const index = hooks.cursor++;
        const slot = hooks.slots[index] ??= {};
        if (!slot.dependencies || dependencies.some((item, position) => !Object.is(item, slot.dependencies![position]))) {
            hooks.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
            slot.dependencies = dependencies;
        }
    },
}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../src/features/McpBridge/api', () => ({ bridgeApi: { preparePlan: vi.fn(), create: vi.fn(),
    approvePlan: vi.fn(), revokePlan: vi.fn(), plan: vi.fn() } }));
vi.mock('antd', () => ({ message: { error: vi.fn() } }));

const app: IStoreApp = { id: 'tool', kind: 'mcp', name: 'Поиск', version: 2, description: '', tags: [], origin: 'catalog' };
const identity = { id: app.id, kind: app.kind, name: app.name, version: app.version };
const failure = { isAxiosError: true, response: { status: 409, data: { code: 'PACKAGE_NOT_INSTALLABLE',
    message: 'Комплект недоступен', reason: 'Внешняя команда без комплекта', package: identity, root: identity,
    dependency: false, path: [identity] } } };
const plan: IInstallPlan = { id: 'plan', projectId: 'project', assetId: app.id, assetKind: app.kind,
    version: app.version, manifest: 'a'.repeat(64), revision: 0, status: 'pending', approvedBy: null,
    files: [], config: null, requirements: {} };
function context(scopeKey = 'first') {
    return { scopeKey, ready: true, canApprove: true, projectId: 'project', deviceId: 'device',
        captureOwner: () => () => true, isPending: () => false, reload: vi.fn(async () => undefined) };
}
function render(value = context()) {
    hooks.cursor = 0;
    const result = useInstallPlan(value);
    hooks.effects.splice(0).forEach(effect => effect());
    return result;
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.effects = []; vi.clearAllMocks(); });
describe('Область постоянного отказа установки', () => {
    it('Сохраняет отказ до закрытия и повторяет только ту же версию после явного действия', async () => {
        vi.mocked(bridgeApi.preparePlan).mockRejectedValueOnce(failure).mockResolvedValueOnce(plan);
        await render().install(app);
        const failed = render();
        expect(failed.failure).toMatchObject({ app, issue: { package: identity } });
        expect(render().failure).not.toBeNull();
        expect(message.error).not.toHaveBeenCalled(); expect(bridgeApi.create).not.toHaveBeenCalled();
        await failed.retryFailure();
        expect(bridgeApi.preparePlan).toHaveBeenNthCalledWith(2, { projectId: 'project', assetId: app.id, assetKind: app.kind, version: 2 });
        expect(render().failure).toBeNull(); expect(render().review?.plan).toEqual(plan);
        expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Закрытие очищает отказ и обезвреживает запоздалый ответ', async () => {
        const pending = deferred<IInstallPlan>();
        vi.mocked(bridgeApi.preparePlan).mockReturnValueOnce(pending.promise);
        const opened = render(); const request = opened.install(app);
        opened.cancel(); pending.reject(failure); await request;
        expect(render().failure).toBeNull(); expect(message.error).not.toHaveBeenCalled();
    });
    it('Старое действие повтора не открывает закрытый отказ заново', async () => {
        vi.mocked(bridgeApi.preparePlan).mockRejectedValueOnce(failure);
        await render().install(app);
        const old = render(); old.cancel();
        await old.retryFailure();
        expect(bridgeApi.preparePlan).toHaveBeenCalledOnce(); expect(render().failure).toBeNull();
    });
    it('Смена проекта скрывает отказ и старый обработчик не блокирует новую область', async () => {
        vi.mocked(bridgeApi.preparePlan).mockRejectedValueOnce(failure).mockResolvedValueOnce(plan);
        await render().install(app);
        const old = render(); expect(old.failure).not.toBeNull();
        expect(render(context('other')).failure).toBeNull();
        await old.retryFailure();
        expect(bridgeApi.preparePlan).toHaveBeenCalledOnce(); expect(render(context('other')).busy).toBe('');
        await render(context('other')).install(app);
        expect(bridgeApi.preparePlan).toHaveBeenCalledTimes(2);
    });
    it('Запоздалый отказ прежнего проекта не открывается поверх текущего', async () => {
        const pending = deferred<IInstallPlan>();
        vi.mocked(bridgeApi.preparePlan).mockReturnValueOnce(pending.promise);
        const request = render().install(app);
        render(context('other')); pending.reject(failure); await request;
        expect(render(context('other')).failure).toBeNull(); expect(message.error).not.toHaveBeenCalled();
    });
    it('Новая попытка другого инструмента убирает старый отказ до ответа сервера', async () => {
        const pending = deferred<IInstallPlan>();
        vi.mocked(bridgeApi.preparePlan).mockRejectedValueOnce(failure).mockReturnValueOnce(pending.promise);
        await render().install(app);
        const next = { ...app, id: 'other' };
        const request = render().install(next);
        expect(render().failure).toBeNull();
        pending.resolve({ ...plan, assetId: next.id }); await request;
        expect(render().review?.app.id).toBe(next.id);
    });
    it('Отказ проверки версии повторяется без установки даже после одобрения', async () => {
        vi.mocked(bridgeApi.preparePlan).mockRejectedValueOnce(failure).mockResolvedValueOnce({ ...plan, status: 'approved' });
        await render().inspect(app); await render().retryFailure();
        expect(render().review?.installOnApprove).toBe(false); expect(bridgeApi.create).not.toHaveBeenCalled();
    });
});
