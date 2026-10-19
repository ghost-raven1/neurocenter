import { describe, expect, it, vi } from 'vitest';

import { createFullBackupSettingsController, initialFullBackupSettingsState } from '../src/modules/Maintenance/fullBackupSettingsController';
import type { IMaintenancePolicy, IMaintenancePolicyResult, IMaintenanceStatus } from '../src/modules/Maintenance/maintenancePolicy';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (failure: Error) => void;
    const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

function policy(): IMaintenancePolicy {
    return {
        enabled: false, timeZone: 'UTC', schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: '02:00' },
        windows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '01:00', end: '05:00' }],
        maxPauseMinutes: 30, localCopies: 5, externalRetentionDays: 30, rpoMinutes: 1440, rtoMinutes: 240,
    };
}

function status(revision = 1): IMaintenanceStatus {
    return {
        revision, policy: policy(), updatedAt: '2026-10-18T02:00:00Z', nextRunAt: null,
        externalAgeSeconds: null, rpoExceeded: true, external: null, runs: [],
    };
}

function harness() {
    let state = initialFullBackupSettingsState();
    let draft: IMaintenancePolicy | null = null;
    const read = vi.fn<() => Promise<IMaintenanceStatus>>().mockResolvedValue(status());
    const write = vi.fn<(revision: number, policy: IMaintenancePolicy) => Promise<IMaintenancePolicyResult>>();
    const onChange = vi.fn((value: typeof state) => { state = value; });
    const onPolicy = vi.fn((value: IMaintenancePolicy) => { draft = value; });
    const onSaved = vi.fn();
    const controller = createFullBackupSettingsController({ read, write, onChange, onPolicy, onSaved });
    controller.activate();
    return { controller, read, write, onChange, onPolicy, onSaved, get state() { return state; }, get draft() { return draft; } };
}

describe('Черновик расписания и конкурирующие запросы', () => {
    it.each([401, 403])('Отказ доступа %s скрывает прежнюю политику и запрещает сохранение', async code => {
        const h = harness();
        await h.controller.refresh();
        h.read.mockRejectedValueOnce({ isAxiosError: true, response: { status: code, data: { message: 'Доступ отозван' } } });
        await h.controller.refresh();
        expect(h.state.status).toBeNull();
        expect(h.state.revision).toBeNull();
        await h.controller.save(policy());
        expect(h.write).not.toHaveBeenCalled();
        h.read.mockResolvedValueOnce(status(7));
        await h.controller.refresh();
        expect(h.state.revision).toBe(7);
        expect(h.onPolicy).toHaveBeenCalledTimes(2);
    });

    it('Отказ доступа во время сохранения скрывает форму, а повтор не отправляет новый PATCH', async () => {
        const h = harness();
        await h.controller.refresh();
        h.write.mockRejectedValueOnce({ isAxiosError: true, response: { status: 403, data: { message: 'Доступ отозван' } } });
        await h.controller.save(policy());
        expect(h.state.status).toBeNull();
        expect(h.state.revision).toBeNull();
        expect(h.state.loadError).toBe('Доступ отозван');
        expect(h.state.saveError).toBeNull();
        expect(h.state.saving).toBe(false);
        await h.controller.save(policy());
        expect(h.write).toHaveBeenCalledTimes(1);
    });

    it('Из двух ответов применяет только последний запрошенный', async () => {
        const h = harness();
        const previous = deferred<IMaintenanceStatus>();
        const current = deferred<IMaintenanceStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
        const first = h.controller.refresh();
        const second = h.controller.refresh();
        current.resolve(status(2));
        await second;
        previous.resolve(status(1));
        await first;
        expect(h.state.status?.revision).toBe(2);
        expect(h.state.revision).toBe(2);
        expect(h.onPolicy).toHaveBeenCalledTimes(1);
        expect(h.state.loading).toBe(false);
    });

    it('Запоздалая ошибка не затирает успешное ручное обновление', async () => {
        const h = harness();
        const previous = deferred<IMaintenanceStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(status(2));
        const first = h.controller.refresh();
        await h.controller.refresh();
        previous.reject(new Error('Старое соединение оборвалось'));
        await first;
        expect(h.state.loadError).toBeNull();
        expect(h.state.status?.revision).toBe(2);
    });

    it('Старый успешный GET не скрывает ошибку более нового обновления', async () => {
        const h = harness();
        await h.controller.refresh();
        const previous = deferred<IMaintenanceStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockRejectedValueOnce(new Error('Новый запрос не прошёл'));
        const poll = h.controller.refresh();
        await h.controller.refresh();
        previous.resolve(status(2));
        await poll;
        expect(h.state.loadError).toBe('Новый запрос не прошёл');
        expect(h.state.status?.revision).toBe(1);
    });

    it('Завершение старого ответа не скрывает загрузку нового', async () => {
        const h = harness();
        const previous = deferred<IMaintenanceStatus>();
        const current = deferred<IMaintenanceStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
        const first = h.controller.refresh();
        const second = h.controller.refresh();
        previous.resolve(status());
        await first;
        expect(h.state.loading).toBe(true);
        expect(h.state.status).toBeNull();
        current.resolve(status(2));
        await second;
        expect(h.state.loading).toBe(false);
    });

    it('Poll обновляет статус без замены черновика и его ревизии', async () => {
        const h = harness();
        await h.controller.refresh();
        h.draft!.timeZone = 'Asia/Tomsk';
        h.read.mockResolvedValueOnce(status(2));
        await h.controller.refresh();
        expect(h.draft?.timeZone).toBe('Asia/Tomsk');
        expect(h.state.revision).toBe(1);
        expect(h.state.status?.revision).toBe(2);
        expect(h.onPolicy).toHaveBeenCalledTimes(1);
    });

    it('Изменение вложенных полей черновика не меняет сохранённые значения', async () => {
        const h = harness();
        await h.controller.refresh();
        h.draft!.schedule.days.push(99);
        h.draft!.windows[0].days.push(99);
        h.draft!.windows[0].start = '03:00';
        expect(h.state.status?.policy.schedule.days).not.toContain(99);
        expect(h.state.status?.policy.windows[0].days).not.toContain(99);
        expect(h.state.status?.policy.windows[0].start).toBe('01:00');
    });

    it('Конфликт сохранения остаётся видимым после успешного poll', async () => {
        const h = harness();
        await h.controller.refresh();
        h.draft!.timeZone = 'Asia/Tomsk';
        h.write.mockRejectedValueOnce(new Error('Настройки уже изменены другим администратором'));
        await h.controller.save(h.draft!);
        h.read.mockResolvedValueOnce(status(2));
        await h.controller.refresh();
        expect(h.state.saveError).toBe('Настройки уже изменены другим администратором');
        expect(h.state.loadError).toBeNull();
        expect(h.state.revision).toBe(1);
        expect(h.draft?.timeZone).toBe('Asia/Tomsk');
    });

    it('Ошибка чтения не подменяет ошибку сохранения и не сбрасывает черновик', async () => {
        const h = harness();
        await h.controller.refresh();
        h.draft!.timeZone = 'Asia/Tomsk';
        h.write.mockRejectedValueOnce(new Error('Конфликт ревизий'));
        await h.controller.save(h.draft!);
        h.read.mockRejectedValueOnce(new Error('Сеть недоступна'));
        await h.controller.refresh();
        expect(h.state.saveError).toBe('Конфликт ревизий');
        expect(h.state.loadError).toBe('Сеть недоступна');
        expect(h.draft?.timeZone).toBe('Asia/Tomsk');
    });

    it('Явная загрузка сохранённых значений принимает новую ревизию и снимает конфликт', async () => {
        const h = harness();
        await h.controller.refresh();
        h.write.mockRejectedValueOnce(new Error('Конфликт ревизий'));
        await h.controller.save(h.draft!);
        const saved = status(2);
        saved.policy.timeZone = 'Asia/Tomsk';
        h.read.mockResolvedValueOnce(saved);
        await h.controller.refresh();
        h.controller.useSavedPolicy();
        expect(h.state.revision).toBe(2);
        expect(h.state.saveError).toBeNull();
        expect(h.draft?.timeZone).toBe('Asia/Tomsk');
        h.draft!.windows[0].start = '04:00';
        expect(h.state.status?.policy.windows[0].start).toBe('01:00');
    });

    it('Сохраняет с ревизией черновика, даже когда статус другого администратора новее', async () => {
        const h = harness();
        await h.controller.refresh();
        h.read.mockResolvedValueOnce(status(2));
        await h.controller.refresh();
        h.write.mockRejectedValueOnce(new Error('Конфликт ревизий'));
        await h.controller.save(h.draft!);
        expect(h.write).toHaveBeenCalledWith(1, h.draft);
        expect(h.state.revision).toBe(1);
    });

    it('Во время PATCH пропускает poll и повторное нажатие сохранения', async () => {
        const h = harness();
        await h.controller.refresh();
        const pending = deferred<IMaintenancePolicyResult>();
        h.write.mockReturnValueOnce(pending.promise);
        const saving = h.controller.save(h.draft!);
        await h.controller.refresh();
        await h.controller.save(h.draft!);
        h.controller.useSavedPolicy();
        expect(h.read).toHaveBeenCalledTimes(1);
        expect(h.write).toHaveBeenCalledTimes(1);
        expect(h.state.saving).toBe(true);
        pending.reject(new Error('Конфликт ревизий'));
        await saving;
        expect(h.state.saving).toBe(false);
    });

    it('GET, начатый до PATCH, не откатывает сохранённую ревизию', async () => {
        const h = harness();
        await h.controller.refresh();
        const previous = deferred<IMaintenanceStatus>();
        const afterSave = deferred<IMaintenanceStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockReturnValueOnce(afterSave.promise);
        const poll = h.controller.refresh();
        h.write.mockResolvedValueOnce({ revision: 2, policy: { ...policy(), timeZone: 'Asia/Tomsk' } });
        const saving = h.controller.save(h.draft!);
        await Promise.resolve();
        previous.resolve(status(1));
        await poll;
        expect(h.state.status?.revision).toBe(2);
        expect(h.state.revision).toBe(2);
        expect(h.draft?.timeZone).toBe('Asia/Tomsk');
        afterSave.resolve({ ...status(2), policy: { ...policy(), timeZone: 'Asia/Tomsk' } });
        await saving;
        expect(h.state.saving).toBe(false);
        expect(h.onSaved).toHaveBeenCalledTimes(1);
    });

    it('Успешный PATCH не превращается в ошибку сохранения при отказе последующего GET', async () => {
        const h = harness();
        await h.controller.refresh();
        h.write.mockResolvedValueOnce({ revision: 2, policy: policy() });
        h.read.mockRejectedValueOnce(new Error('Статус временно недоступен'));
        await h.controller.save(h.draft!);
        expect(h.state.revision).toBe(2);
        expect(h.state.status?.revision).toBe(2);
        expect(h.state.saveError).toBeNull();
        expect(h.state.loadError).toBe('Статус временно недоступен');
        expect(h.state.loading).toBe(false);
        expect(h.state.saving).toBe(false);
        expect(h.onSaved).toHaveBeenCalledTimes(1);
    });

    it('После размонтирования не применяет статус, черновик или ошибку', async () => {
        const h = harness();
        const pending = deferred<IMaintenanceStatus>();
        h.read.mockReturnValueOnce(pending.promise);
        const loading = h.controller.refresh();
        h.controller.dispose();
        h.onChange.mockClear();
        pending.resolve(status());
        await loading;
        expect(h.onChange).not.toHaveBeenCalled();
        expect(h.onPolicy).not.toHaveBeenCalled();
        await h.controller.refresh();
        await h.controller.save(policy());
        expect(h.read).toHaveBeenCalledTimes(1);
        expect(h.write).not.toHaveBeenCalled();
    });

    it('Смена владельца сбрасывает ревизию и игнорирует прежний ответ', async () => {
        const h = harness();
        await h.controller.refresh();
        const previous = deferred<IMaintenanceStatus>();
        h.read.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(status(7));
        const loading = h.controller.refresh();
        h.controller.dispose();
        h.controller.activate();
        expect(h.state).toEqual(initialFullBackupSettingsState());
        await h.controller.refresh();
        previous.resolve(status(2));
        await loading;
        expect(h.state.revision).toBe(7);
        expect(h.state.status?.revision).toBe(7);
    });

    it('Ответ PATCH старого владельца не показывает успех и не меняет нового', async () => {
        const h = harness();
        await h.controller.refresh();
        const previous = deferred<IMaintenancePolicyResult>();
        h.write.mockReturnValueOnce(previous.promise);
        const saving = h.controller.save(policy());
        h.controller.dispose();
        h.controller.activate();
        h.read.mockResolvedValueOnce(status(7));
        await h.controller.refresh();
        previous.resolve({ revision: 2, policy: policy() });
        await saving;
        expect(h.state.revision).toBe(7);
        expect(h.state.saving).toBe(false);
        expect(h.onSaved).not.toHaveBeenCalled();
        expect(h.onPolicy).toHaveBeenCalledTimes(2);
    });

    it('Ошибка PATCH прежнего аккаунта не разблокирует сохранение нового', async () => {
        const h = harness();
        await h.controller.refresh();
        const previous = deferred<IMaintenancePolicyResult>();
        const current = deferred<IMaintenancePolicyResult>();
        h.write.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
        const first = h.controller.save(policy());
        h.controller.dispose();
        h.controller.activate();
        h.read.mockResolvedValueOnce(status(7));
        await h.controller.refresh();
        const second = h.controller.save(policy());
        previous.reject(new Error('Конфликт прежнего аккаунта'));
        await first;
        expect(h.state.saving).toBe(true);
        expect(h.state.saveError).toBeNull();
        current.reject(new Error('Конфликт текущего аккаунта'));
        await second;
        expect(h.state.saving).toBe(false);
        expect(h.state.saveError).toBe('Конфликт текущего аккаунта');
    });
});
