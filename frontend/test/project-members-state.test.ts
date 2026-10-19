import { describe, expect, it, vi } from 'vitest';
import type { IProjectMember } from '../src/core/api/interfaces';
import { createProjectMembersController, initialProjectMembersState } from '../src/modules/Projects/projectMembersController';

const administrator = { userId: 'сотрудник', role: 'Админ проекта' } as IProjectMember;
const observer = { ...administrator, role: 'Наблюдатель' };
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
function setup() {
    let ownerCurrent = true;
    let state = initialProjectMembersState();
    const read = vi.fn<() => Promise<IProjectMember[]>>().mockResolvedValue([administrator]);
    const onChange = vi.fn((next: typeof state) => { state = next; });
    const controller = createProjectMembersController({ read, onChange, isOwnerCurrent: () => ownerCurrent });
    controller.activate();
    return { controller, read, onChange, state: () => state, revokeOwner: () => { ownerCurrent = false; } };
}

describe('Актуальный список сотрудников проекта', () => {
    it('Поздний ответ не возвращает сотруднику прежнюю роль', async () => {
        const test = setup();
        const old = deferred<IProjectMember[]>();
        test.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce([observer]);
        const pending = test.controller.refresh();
        await test.controller.refresh();
        old.resolve([administrator]);
        await pending;
        expect(test.state()).toEqual({ members: [observer], loading: false, loadError: false });
    });

    it('Ошибка старого чтения не стирает новый список', async () => {
        const test = setup();
        const old = deferred<IProjectMember[]>();
        test.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce([observer]);
        const pending = test.controller.refresh();
        await test.controller.refresh();
        old.reject(new Error('Поздний отказ'));
        await pending;
        expect(test.state()).toEqual({ members: [observer], loading: false, loadError: false });
    });

    it('Завершение прежнего чтения не выключает индикатор нового запроса', async () => {
        const test = setup();
        const old = deferred<IProjectMember[]>();
        const current = deferred<IProjectMember[]>();
        test.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        const first = test.controller.refresh();
        const second = test.controller.refresh();
        old.resolve([administrator]); await first;
        expect(test.state().loading).toBe(true);
        expect(test.state().members).toEqual([]);
        current.resolve([observer]); await second;
        expect(test.state().members).toEqual([observer]);
    });

    it('Смена аккаунта или прав отсекает ответ до React cleanup и запрещает старый повтор', async () => {
        const test = setup();
        const old = deferred<IProjectMember[]>();
        test.read.mockReturnValueOnce(old.promise);
        const pending = test.controller.refresh();
        const changes = test.onChange.mock.calls.length;
        test.revokeOwner(); old.resolve([administrator]); await pending;
        await test.controller.refresh();
        expect(test.onChange).toHaveBeenCalledTimes(changes);
        expect(test.read).toHaveBeenCalledTimes(1);
    });

    it('Размонтирование не принимает прежний ответ после повторной активации', async () => {
        const test = setup();
        const old = deferred<IProjectMember[]>();
        test.read.mockReturnValueOnce(old.promise);
        const pending = test.controller.refresh();
        test.controller.dispose(); test.controller.activate();
        test.read.mockResolvedValueOnce([observer]); await test.controller.refresh();
        old.resolve([administrator]); await pending;
        expect(test.state().members).toEqual([observer]);
    });

    it('Временный отказ сохраняет известный список и сообщает об ошибке, повтор восстанавливает чтение', async () => {
        const test = setup();
        await test.controller.refresh();
        test.read.mockRejectedValueOnce(new Error('Нет связи')); await test.controller.refresh();
        expect(test.state()).toEqual({ members: [administrator], loading: false, loadError: true });
        test.read.mockResolvedValueOnce([observer]); await test.controller.refresh();
        expect(test.state()).toEqual({ members: [observer], loading: false, loadError: false });
    });

    it.each([401, 403, 404])('Отказ %i убирает ранее доступные сведения', async status => {
        const test = setup();
        await test.controller.refresh();
        test.read.mockRejectedValueOnce({ isAxiosError: true, response: { status } });
        await test.controller.refresh();
        expect(test.state()).toEqual({ members: [], loading: false, loadError: true });
    });

    it('Первый отказ не выдаётся за успешный пустой список', async () => {
        const test = setup();
        test.read.mockRejectedValueOnce(new Error('Нет связи')); await test.controller.refresh();
        expect(test.state()).toEqual({ members: [], loading: false, loadError: true });
    });
});
