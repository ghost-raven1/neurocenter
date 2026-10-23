import { describe, expect, it, vi } from 'vitest';
import { createFeatureFlagsController, initialFeatureFlagsState } from '../src/features/FeatureFlags/featureFlagsController';
import { featureDefinition, featureFlagKeys, requireFeatureFlagList } from '../src/features/FeatureFlags/types';
import type { IFeatureFlag, TFeatureFlagKey } from '../src/features/FeatureFlags/types';

const flag = (key: TFeatureFlagKey, enabled = true, revision = 1): IFeatureFlag => ({ ...featureDefinition(key), key, name: key, description: 'Описание функции', enabled, revision, updatedAt: '2026-10-19T12:00:00Z', updatedBy: 'system:defaults' });
const list = (...overrides: IFeatureFlag[]) => ({ items: featureFlagKeys.map(key => overrides.find(item => item.key === key) ?? flag(key)) });
const httpError = (status: number) => ({ isAxiosError: true, response: { status, data: { message: status === 409 ? 'Настройка изменилась' : 'Доступ запрещён' } } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function harness() {
    let current = true, state = initialFeatureFlagsState();
    const read = vi.fn(async (): Promise<unknown> => list());
    const write = vi.fn(async (key: TFeatureFlagKey, enabled: boolean, revision: number): Promise<unknown> => flag(key, enabled, revision + 1));
    const changed = vi.fn(value => { state = value; });
    const controller = createFeatureFlagsController({ read, write, onChange: changed, captureOwner: () => () => current });
    controller.activate();
    return { controller, read, write, changed, get state() { return state; }, loseOwner: () => { current = false; } };
}

describe('Состояние функций платформы', () => {
    it('До подтверждённого ответа состояние неизвестно, ошибка сети не подменяет его defaults', async () => {
        const h = harness(); h.read.mockRejectedValue(new Error('Нет связи'));
        expect(h.state.items).toBeNull(); await h.controller.refresh();
        expect(h.state.items).toBeNull(); expect(h.state.readError).toBe('Нет связи');
        await h.controller.save('model_hosting', false); expect(h.write).not.toHaveBeenCalled();
    });
    it('Требует полный набор уникальных функций и корректное булево состояние', () => {
        expect(requireFeatureFlagList({ items: [...list().items].reverse() }).map(item => item.key)).toEqual(featureFlagKeys);
        expect(() => requireFeatureFlagList({ items: [flag('model_hosting')] })).toThrow('неполный');
        expect(() => requireFeatureFlagList({ items: Array(featureFlagKeys.length).fill(flag('model_hosting')) })).toThrow('повторяющиеся');
        expect(() => requireFeatureFlagList(list({ ...flag('tool_builds'), enabled: 'false' as unknown as boolean }))).toThrow('не подтвердил');
    });
    it('Переключатель меняется после ответа, повторное нажатие не создаёт PATCH', async () => {
        const h = harness(); await h.controller.refresh(); const pending = deferred<IFeatureFlag>(); h.write.mockReturnValue(pending.promise);
        const saving = h.controller.save('model_hosting', false); await h.controller.save('model_hosting', false);
        expect(h.write).toHaveBeenCalledOnce(); expect(h.write).toHaveBeenCalledWith('model_hosting', false, 1);
        expect(h.state.items?.[0].enabled).toBe(true); expect(h.state.rows.model_hosting.saving).toBe(true);
        pending.resolve(flag('model_hosting', false, 2)); await saving;
        expect(h.state.items?.[0].enabled).toBe(false); expect(h.state.rows.model_hosting).toMatchObject({ saving: false, saved: true, error: null });
    });
    it('Разные строки сохраняются независимо, поздний ответ не стирает соседнюю строку', async () => {
        const h = harness(); await h.controller.refresh(); const one = deferred<IFeatureFlag>(), two = deferred<IFeatureFlag>();
        h.write.mockImplementation(key => key === 'model_hosting' ? one.promise : two.promise);
        const first = h.controller.save('model_hosting', false), second = h.controller.save('rag_sync', false);
        expect(h.write).toHaveBeenCalledTimes(2); two.resolve(flag('rag_sync', false, 2)); await second;
        expect(h.state.rows.model_hosting.saving).toBe(true); expect(h.state.rows.rag_sync.saving).toBe(false);
        one.resolve(flag('model_hosting', false, 2)); await first;
        expect(h.state.items?.filter(item => !item.enabled).map(item => item.key)).toEqual(['model_hosting', 'rag_sync']);
    });
    it('Live-перечитывание во время записи ставится в очередь и не накладывается на PATCH', async () => {
        const h = harness(); await h.controller.refresh(); const pending = deferred<IFeatureFlag>(); h.write.mockReturnValue(pending.promise);
        const saving = h.controller.save('model_hosting', false); await h.controller.refresh(); await h.controller.refresh();
        expect(h.read).toHaveBeenCalledOnce();
        h.read.mockResolvedValue(list(flag('model_hosting', false, 2), flag('tool_builds'), flag('rag_sync')));
        pending.resolve(flag('model_hosting', false, 2)); await saving; await flush();
        expect(h.read).toHaveBeenCalledTimes(2); expect(h.state.items?.[0].enabled).toBe(false);
    });
    it('Конфликт перечитывает значение и требует явного просмотра без автоповтора изменения', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(409));
        h.read.mockResolvedValue(list(flag('model_hosting', false, 3), flag('tool_builds'), flag('rag_sync')));
        await h.controller.save('model_hosting', false); await flush();
        expect(h.read).toHaveBeenCalledTimes(2); expect(h.state.items?.[0]).toMatchObject({ enabled: false, revision: 3 });
        expect(h.state.rows.model_hosting.needsReview).toBe(true);
        await h.controller.save('model_hosting', true); expect(h.write).toHaveBeenCalledOnce();
        h.controller.useCurrent('model_hosting'); expect(h.write).toHaveBeenCalledOnce();
        expect(h.state.rows.model_hosting).toMatchObject({ needsReview: false, error: null });
        await h.controller.save('model_hosting', true); expect(h.write).toHaveBeenLastCalledWith('model_hosting', true, 3);
    });
    it('Ошибка записи не подменяет значение; проверка состояния позволяет безопасно повторить', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(new Error('Нет ответа'));
        await h.controller.save('tool_builds', false);
        expect(h.state.items?.[1].enabled).toBe(true); expect(h.state.rows.tool_builds.error).toBe('Нет ответа');
        await h.controller.refresh(); expect(h.state.rows.tool_builds.error).toBeNull();
        await h.controller.retryChoice('tool_builds'); expect(h.state.items?.[1].enabled).toBe(false);
    });
    it('503 сохраняет выбранное значение после перепроверки без автоматического PATCH и ложного успеха', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(503));
        await h.controller.save('tool_builds', false);
        expect(h.state.items?.[1]).toMatchObject({ enabled: true, revision: 1 });
        expect(h.state.rows.tool_builds).toMatchObject({ choice: { enabled: false, reviewedRevision: null }, saved: false, saving: false });
        h.read.mockResolvedValue(list(flag('tool_builds', true, 3))); await h.controller.refresh();
        expect(h.state.rows.tool_builds).toMatchObject({ choice: { enabled: false, reviewedRevision: 3 }, saved: false });
        expect(h.write).toHaveBeenCalledExactlyOnceWith('tool_builds', false, 1);
        await h.controller.retryChoice('tool_builds');
        expect(h.write).toHaveBeenLastCalledWith('tool_builds', false, 3);
        expect(h.state.items?.[1]).toMatchObject({ enabled: false, revision: 4 });
        expect(h.state.rows.tool_builds).toMatchObject({ choice: undefined, saved: true });
    });
    it('GET после неизвестного ACK может совпасть с выбором, но не подтверждает PATCH и не повторяет его', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(503));
        await h.controller.save('tool_builds', false);
        h.read.mockResolvedValue(list(flag('tool_builds', false, 7))); await h.controller.refresh();
        expect(h.state.items?.[1]).toMatchObject({ enabled: false, revision: 7 });
        expect(h.state.rows.tool_builds).toMatchObject({ choice: { enabled: false, reviewedRevision: 7 }, saved: false });
        await h.controller.retryChoice('tool_builds'); expect(h.write).toHaveBeenCalledOnce();
        h.controller.useCurrent('tool_builds');
        expect(h.state.rows.tool_builds).toMatchObject({ choice: undefined, saved: false });
        expect(h.write).toHaveBeenCalledOnce();
    });
    it('Непроверенный выбор и ошибка GET не разрешают повтор или тихую замену выбора', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(503));
        await h.controller.save('rag_sync', false);
        await h.controller.retryChoice('rag_sync'); await h.controller.save('rag_sync', false); h.controller.useCurrent('rag_sync');
        expect(h.write).toHaveBeenCalledOnce();
        expect(h.state.rows.rag_sync.choice).toEqual({ enabled: false, reviewedRevision: null });
        h.read.mockRejectedValueOnce(new Error('GET недоступен')); await h.controller.refresh();
        await h.controller.retryChoice('rag_sync'); h.controller.useCurrent('rag_sync');
        expect(h.state.rows.rag_sync.choice).toEqual({ enabled: false, reviewedRevision: null });
        expect(h.state.readError).toBe('GET недоступен'); expect(h.write).toHaveBeenCalledOnce();
        h.read.mockResolvedValue(list(flag('rag_sync', true, 5))); await h.controller.refresh();
        h.controller.useCurrent('rag_sync'); expect(h.state.rows.rag_sync.choice).toBeUndefined();
        expect(h.state.items?.[2]).toMatchObject({ enabled: true, revision: 5 }); expect(h.write).toHaveBeenCalledOnce();
    });
    it('409 сохраняет выбор, а каждый явный повтор использует ревизию новой GET-перепроверки', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(409));
        h.read.mockResolvedValueOnce(list(flag('model_hosting', true, 6)));
        await h.controller.save('model_hosting', false); await flush();
        expect(h.state.rows.model_hosting).toMatchObject({ needsReview: true, choice: { enabled: false, reviewedRevision: 6 } });
        expect(h.write).toHaveBeenCalledOnce();
        h.write.mockRejectedValueOnce(httpError(409)); h.read.mockResolvedValueOnce(list(flag('model_hosting', true, 8)));
        await h.controller.retryChoice('model_hosting'); await flush();
        expect(h.write).toHaveBeenLastCalledWith('model_hosting', false, 6);
        expect(h.state.rows.model_hosting).toMatchObject({ saved: false, choice: { enabled: false, reviewedRevision: 8 } });
        expect(h.write).toHaveBeenCalledTimes(2);
        await h.controller.retryChoice('model_hosting');
        expect(h.write).toHaveBeenLastCalledWith('model_hosting', false, 8);
        expect(h.state.rows.model_hosting).toMatchObject({ choice: undefined, needsReview: false, saved: true });
    });
    it('Потерянный ACK явного повтора снова требует GET, а не повторяет последний CAS', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(503));
        await h.controller.save('tool_builds', false);
        h.read.mockResolvedValue(list(flag('tool_builds', true, 3))); await h.controller.refresh();
        h.write.mockRejectedValueOnce(httpError(503)); await h.controller.retryChoice('tool_builds');
        expect(h.write).toHaveBeenLastCalledWith('tool_builds', false, 3);
        expect(h.state.rows.tool_builds.choice).toEqual({ enabled: false, reviewedRevision: null });
        await h.controller.retryChoice('tool_builds'); expect(h.write).toHaveBeenCalledTimes(2);
    });
    it('Выбор прежней панели не переносится в новый scope, поздние ACK и GET его не восстанавливают', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(503));
        await h.controller.save('model_hosting', false); expect(h.state.rows.model_hosting.choice?.enabled).toBe(false);
        const read = deferred<unknown>(); h.read.mockReturnValueOnce(read.promise); const previous = h.controller.refresh();
        h.controller.dispose(); h.controller.activate(); h.read.mockResolvedValue(list()); await h.controller.refresh();
        read.resolve(list(flag('model_hosting', false, 9))); await previous;
        expect(h.state.rows.model_hosting.choice).toBeUndefined(); expect(h.state.items?.[0]).toMatchObject({ enabled: true, revision: 1 });
        await h.controller.retryChoice('model_hosting'); expect(h.write).toHaveBeenCalledOnce();
    });
    it('Конфликт с неудачной перечиткой нельзя принять до успешного обновления', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockRejectedValueOnce(httpError(409)); h.read.mockRejectedValueOnce(new Error('Нет связи'));
        await h.controller.save('rag_sync', false); await flush(); h.controller.useCurrent('rag_sync');
        expect(h.state.rows.rag_sync.needsReview).toBe(true); expect(h.state.readError).toBe('Нет связи');
        await h.controller.save('rag_sync', false); expect(h.write).toHaveBeenCalledOnce();
        h.read.mockResolvedValue(list(flag('model_hosting'), flag('tool_builds'), flag('rag_sync', false, 2)));
        await h.controller.refresh(); expect(h.state.rows.rag_sync.needsReview).toBe(true);
        h.controller.useCurrent('rag_sync'); expect(h.state.rows.rag_sync.needsReview).toBe(false); expect(h.write).toHaveBeenCalledOnce();
    });
    it('Не объявляет успех по некорректному подтверждению PATCH', async () => {
        const h = harness(); await h.controller.refresh(); h.write.mockResolvedValue(flag('model_hosting', false, 1));
        await h.controller.save('model_hosting', false);
        expect(h.state.items?.[0].enabled).toBe(true); expect(h.state.rows.model_hosting.saved).toBe(false);
        expect(h.state.rows.model_hosting.error).toContain('не подтвердил');
        expect(h.state.rows.model_hosting.choice).toEqual({ enabled: false, reviewedRevision: null });
    });
    it('Отказ доступа очищает прежние значения, временный отказ их сохраняет с предупреждением', async () => {
        const h = harness(); await h.controller.refresh(); h.read.mockRejectedValueOnce(new Error('Нет связи'));
        await h.controller.refresh(); expect(h.state.items).toHaveLength(featureFlagKeys.length); expect(h.state.readError).toBe('Нет связи');
        h.read.mockRejectedValueOnce(httpError(403)); await h.controller.refresh();
        expect(h.state.items).toBeNull(); expect(h.state.readError).toBe('Доступ запрещён');
    });
});

describe('Владелец запросов функций и StrictMode', () => {
    it.each(['success', 'failure'] as const)('Поздний %s PATCH прежнего владельца не обновляет панель', async outcome => {
        const h = harness(); await h.controller.refresh(); const pending = deferred<IFeatureFlag>(); h.write.mockReturnValue(pending.promise);
        const saving = h.controller.save('model_hosting', false); const before = h.changed.mock.calls.length; h.loseOwner();
        if (outcome === 'success') pending.resolve(flag('model_hosting', false, 2)); else pending.reject(new Error('Отказ'));
        await saving; expect(h.changed).toHaveBeenCalledTimes(before); expect(h.read).toHaveBeenCalledOnce();
    });
    it('StrictMode setup-cleanup-setup не принимает старый GET и завершает актуальную загрузку', async () => {
        const h = harness(); const first = deferred<unknown>(), second = deferred<unknown>();
        h.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const previous = h.controller.refresh(); h.controller.dispose(); h.controller.activate(); const current = h.controller.refresh();
        second.resolve(list(flag('model_hosting', false, 2), flag('tool_builds'), flag('rag_sync'))); await current;
        expect(h.state.items?.[0].enabled).toBe(false); expect(h.state.loading).toBe(false);
        const before = h.changed.mock.calls.length; first.resolve(list()); await previous;
        expect(h.changed).toHaveBeenCalledTimes(before); expect(h.state.items?.[0].enabled).toBe(false);
    });
    it('Закрытая панель не применяет GET и не повторяет queued refresh', async () => {
        const h = harness(); await h.controller.refresh(); const pending = deferred<IFeatureFlag>(); h.write.mockReturnValue(pending.promise);
        const saving = h.controller.save('model_hosting', false); await h.controller.refresh(); h.controller.dispose();
        const before = h.changed.mock.calls.length; pending.resolve(flag('model_hosting', false, 2)); await saving;
        expect(h.changed).toHaveBeenCalledTimes(before); expect(h.read).toHaveBeenCalledOnce();
    });
    it('Завершение записи прежнего mount не снимает блокировку новой записи той же строки', async () => {
        const h = harness(); await h.controller.refresh(); const first = deferred<IFeatureFlag>(), second = deferred<IFeatureFlag>();
        h.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const previous = h.controller.save('model_hosting', false);
        h.controller.dispose(); h.controller.activate(); await h.controller.refresh();
        const current = h.controller.save('model_hosting', false); const before = h.changed.mock.calls.length;
        first.resolve(flag('model_hosting', false, 2)); await previous;
        expect(h.changed).toHaveBeenCalledTimes(before); expect(h.state.rows.model_hosting.saving).toBe(true);
        await h.controller.save('model_hosting', false); expect(h.write).toHaveBeenCalledTimes(2);
        second.resolve(flag('model_hosting', false, 2)); await current;
        expect(h.state.rows.model_hosting.saving).toBe(false); expect(h.state.items?.[0].enabled).toBe(false);
    });
});
