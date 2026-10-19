import { describe, expect, it, vi } from 'vitest';
import type { IInstallPlan } from '../src/features/McpBridge/api';
import { prepareInstallation, type IPlanExecution } from '../src/modules/Store/installPlans/installPlanFlow';
import { prepareProjectCatalogInstall } from '../src/modules/Store/prepareProjectCatalogInstall';

const plan: IInstallPlan = {
    id: 'approved-plugin', projectId: 'project-a', assetId: 'rag-plugin', assetKind: 'plugin', version: 3,
    manifest: 'a'.repeat(64), status: 'approved', revision: 1, approvedBy: 'admin',
    files: [], config: null, requirements: {},
};
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
function setup(inProject = false, canManage = true) {
    let current = true;
    const add = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const flow: IPlanExecution = {
        current: () => current,
        prepareCatalog: () => prepareProjectCatalogInstall({ inProject, canManage, current: () => current, add, refresh }),
        api: { preparePlan: vi.fn(async () => plan), approvePlan: vi.fn(async () => plan) },
        enqueue: vi.fn(async () => undefined),
    };
    return { flow, add, refresh, invalidate: () => { current = false; } };
}

describe('Установка через мост одним действием добавляет инструмент в каталог проекта', () => {
    it('Добавляет, обновляет каталог и отправляет ровно один план точной выбранной версии', async () => {
        const test = setup();
        const order: string[] = [];
        test.add.mockImplementation(async () => { order.push('add'); });
        test.refresh.mockImplementation(async () => { order.push('refresh'); });
        vi.mocked(test.flow.api.preparePlan).mockImplementation(async () => { order.push('prepare'); return plan; });
        vi.mocked(test.flow.enqueue).mockImplementation(async () => { order.push('enqueue'); });
        await prepareInstallation(plan, test.flow);
        expect(order).toEqual(['add', 'refresh', 'prepare', 'enqueue']);
        expect(test.flow.api.preparePlan).toHaveBeenCalledExactlyOnceWith(plan);
        expect(test.flow.enqueue).toHaveBeenCalledExactlyOnceWith(plan);
        expect(test.flow.api.approvePlan).not.toHaveBeenCalled();
    });

    it('Уже доступный инструмент разработчика не добавляется повторно', async () => {
        const test = setup(true, false);
        await prepareInstallation(plan, test.flow);
        expect(test.add).not.toHaveBeenCalled();
        expect(test.refresh).not.toHaveBeenCalled();
        expect(test.flow.enqueue).toHaveBeenCalledExactlyOnceWith(plan);
    });

    it('Роль разработчика не добавляет отсутствующий инструмент', async () => {
        const test = setup(false, false);
        await expect(prepareInstallation(plan, test.flow)).rejects.toThrow('администратор');
        expect(test.add).not.toHaveBeenCalled();
        expect(test.flow.api.preparePlan).not.toHaveBeenCalled();
        expect(test.flow.enqueue).not.toHaveBeenCalled();
    });

    it.each(['проект', 'профиль', 'закрытие экрана'])('Смена контекста во время добавления: %s', async () => {
        const test = setup();
        const pending = deferred();
        test.add.mockReturnValue(pending.promise);
        const result = prepareInstallation(plan, test.flow);
        test.invalidate(); pending.resolve();
        await result;
        expect(test.refresh).not.toHaveBeenCalled();
        expect(test.flow.api.preparePlan).not.toHaveBeenCalled();
        expect(test.flow.enqueue).not.toHaveBeenCalled();
    });

    it('Смена контекста при обновлении каталога не запускает установку', async () => {
        const test = setup();
        const pending = deferred();
        test.refresh.mockReturnValue(pending.promise);
        const result = prepareInstallation(plan, test.flow);
        await vi.waitFor(() => expect(test.refresh).toHaveBeenCalledOnce());
        test.invalidate(); pending.resolve();
        await result;
        expect(test.flow.api.preparePlan).not.toHaveBeenCalled();
        expect(test.flow.enqueue).not.toHaveBeenCalled();
    });

    it('Ошибка добавления останавливает подготовку и не создаёт задание', async () => {
        const test = setup();
        test.add.mockRejectedValue(new Error('Каталог недоступен'));
        await expect(prepareInstallation(plan, test.flow)).rejects.toThrow('Каталог недоступен');
        expect(test.refresh).not.toHaveBeenCalled();
        expect(test.flow.api.preparePlan).not.toHaveBeenCalled();
        expect(test.flow.enqueue).not.toHaveBeenCalled();
    });

    it('Первое использование оставляет явное одобрение точного манифеста', async () => {
        const test = setup();
        const pending = { ...plan, status: 'pending' as const, revision: 0, approvedBy: null };
        vi.mocked(test.flow.api.preparePlan).mockResolvedValue(pending);
        expect(await prepareInstallation(plan, test.flow)).toEqual(pending);
        expect(test.add).toHaveBeenCalledOnce();
        expect(test.flow.enqueue).not.toHaveBeenCalled();
        expect(test.flow.api.approvePlan).not.toHaveBeenCalled();
    });

    it('Просмотр разрешения не добавляет инструмент и не запускает установку', async () => {
        const test = setup();
        expect(await prepareInstallation(plan, test.flow, true)).toEqual(plan);
        expect(test.add).not.toHaveBeenCalled();
        expect(test.refresh).not.toHaveBeenCalled();
        expect(test.flow.enqueue).not.toHaveBeenCalled();
    });
});
