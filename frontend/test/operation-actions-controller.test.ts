import { describe, expect, it, vi } from 'vitest';

import type { IOperation,IOperationActionResult } from '../src/core/api/interfaces';
import type { IUserInfo } from '../src/core/interfaces';
import { createOperationActionsController } from '../src/modules/Operations/operationActionsController';

const user: IUserInfo = {
    id: 'owner', email: 'owner@example.test', principalName: 'owner@example.test', displayName: 'Владелец',
    activeRole: 'Разработчик', userRoles: ['Разработчик'], routePermissions: ['/operations'],
    projectRoles: [{ projectId: 'prj-example', projectName: 'example', role: 'Разработчик' }],
};
const operation: IOperation = {
    operationId: 'bridge-12345678-1234-1234-1234-123456789abc',
    resourceType: 'bridge', resourceId: '12345678-1234-1234-1234-123456789abc',
    actor: user.email, projectId: 'prj-example', type: 'INSTALL', state: 'FAILED',
    percent: 50, bytesDone: 0, bytesTotal: 0, startedAt: null, finishedAt: null, error: 'Сбой',
    bridgeJob: {kind:'install',retrySupported:true,minimumLevel:2},
    actions:{executor:'bridge',digest:'a'.repeat(64),retry:{supported:true},cancel:{supported:true}},
};
const job = { operationId: 'bridge-new-job', state: 'QUEUED', message: '' } as IOperationActionResult;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function setup(initialUser: IUserInfo = user) {
    let currentUser: IUserInfo | null = structuredClone(initialUser);
    const dialogs: Array<{ confirm: () => Promise<void>; close: () => void; destroy: ReturnType<typeof vi.fn> }> = [];
    const options = {
        getUser: () => currentUser,
        retry: vi.fn<(id: string, key: string,digest:string) => Promise<IOperationActionResult>>().mockResolvedValue(job),
        cancel: vi.fn<(id: string,key:string,digest:string) => Promise<IOperationActionResult>>().mockResolvedValue({operationId:operation.operationId,state:'CANCELLED',message:'cancelled fixture'}),
        reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        confirmCancel: vi.fn((confirm: () => Promise<void>, close: () => void) => {
            const dialog = { confirm, close, destroy: vi.fn() };
            dialogs.push(dialog);
            return dialog;
        }),
        success: vi.fn(), error: vi.fn(), info: vi.fn(), onBusyChange: vi.fn<(ids: ReadonlySet<string>) => void>(),
        requestKey: vi.fn<() => string>().mockReturnValueOnce('key-first').mockReturnValue('key-next'),
    };
    const controller = createOperationActionsController(options);
    controller.activate();
    return {
        controller, options, dialogs,
        setUser: (next: IUserInfo | null) => { currentUser = next; },
        busy: () => [...(options.onBusyChange.mock.lastCall?.[0] ?? [])],
    };
}

describe('Действия очереди принадлежат текущему пользователю', () => {
    it('Ошибка подготовки ключа повтора снимает блокировку и допускает новую попытку', async () => {
        const { controller, options, busy } = setup();
        options.requestKey.mockReset().mockImplementationOnce(() => { throw new Error('Не удалось подготовить повтор'); })
            .mockReturnValue('fresh-key');
        await expect(controller.retry(operation)).resolves.toBeUndefined();
        expect(busy()).toEqual([]);
        expect(options.error).toHaveBeenCalledWith('Не удалось подготовить повтор');
        expect(options.retry).not.toHaveBeenCalled();
        await controller.retry(operation);
        expect(options.retry).toHaveBeenCalledWith(operation.operationId, 'fresh-key',operation.actions!.digest);
        expect(busy()).toEqual([]);
    });

    it('Не повторяет старую передачу, для которой нужно открыть базу знаний и выбрать текущую папку', async () => {
        const { controller, options } = setup();
        await controller.retry({ ...operation, type: 'SYNC', error: 'Синхронизация требует проверки плана в MCP. Изменения не подтверждены.' });
        expect(options.retry).not.toHaveBeenCalled();
        expect(options.requestKey).not.toHaveBeenCalled();
    });

    it('Сохраняет ключ повтора после сетевого сбоя и удаляет после подтверждённого результата', async () => {
        const { controller, options } = setup();
        options.retry.mockRejectedValueOnce(new Error('Нет связи'));
        await controller.retry(operation);
        await controller.retry(operation);
        await controller.retry(operation);
        expect(options.retry.mock.calls.map(call => call[1])).toEqual(['key-first', 'key-first', 'key-next']);
        expect(options.error).toHaveBeenCalledWith('Нет связи');
        expect(options.reload).toHaveBeenCalledTimes(2);
    });

    it('Не повторяет один запрос дважды и сохраняет занятость каждой параллельной операции', async () => {
        const first = deferred<IOperationActionResult>();
        const second = deferred<IOperationActionResult>();
        const { controller, options, busy } = setup();
        const other = { ...operation, operationId: 'other-operation', resourceId: 'abcdef12-1234-1234-1234-123456789abc' };
        options.retry.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const firstRequest = controller.retry(operation);
        const secondRequest = controller.retry(other);
        await controller.retry(operation);
        expect(options.retry).toHaveBeenCalledTimes(2);
        expect(busy()).toEqual([operation.operationId, other.operationId]);
        first.resolve(job);
        await firstRequest;
        expect(busy()).toEqual([other.operationId]);
        second.resolve(job);
        await secondRequest;
        expect(busy()).toEqual([]);
    });

    it.each(['смена аккаунта', 'отзыв роли', 'отзыв проекта', 'выход'])(
        'Запоздалый повтор не обновляет интерфейс после события: %s', async reason => {
            const pending = deferred<IOperationActionResult>();
            const { controller, options, setUser } = setup();
            options.retry.mockReturnValueOnce(pending.promise);
            const request = controller.retry(operation);
            const changes: Record<string, IUserInfo | null> = {
                'смена аккаунта': { ...user, id: 'other', email: 'other@example.test' },
                'отзыв роли': { ...user, userRoles: [] },
                'отзыв проекта': { ...user, projectRoles: [] },
                'выход': null,
            };
            setUser(changes[reason]);
            const busyChanges = options.onBusyChange.mock.calls.length;
            pending.resolve(job);
            await request;
            expect(options.success).not.toHaveBeenCalled();
            expect(options.error).not.toHaveBeenCalled();
            expect(options.reload).not.toHaveBeenCalled();
            expect(options.onBusyChange).toHaveBeenCalledTimes(busyChanges);
        },
    );

    it('Не показывает ошибку старого запроса после размонтирования', async () => {
        const pending = deferred<IOperationActionResult>();
        const { controller, options } = setup();
        options.retry.mockReturnValueOnce(pending.promise);
        const request = controller.retry(operation);
        controller.dispose();
        pending.reject(new Error('Нет связи'));
        await request;
        expect(options.error).not.toHaveBeenCalled();
        expect(options.reload).not.toHaveBeenCalled();
    });

    it('Старое подтверждение не отправляет отмену после смены активной роли', async () => {
        const { controller, options, dialogs, setUser } = setup();
        controller.cancel({ ...operation, state: 'QUEUED' });
        setUser({ ...user, activeRole: 'Наблюдатель', userRoles: ['Наблюдатель'] });
        await dialogs[0].confirm();
        expect(options.cancel).not.toHaveBeenCalled();
    });

    it('Уничтожает подтверждение при размонтировании и блокирует его запоздалый callback', async () => {
        const { controller, options, dialogs } = setup();
        controller.cancel({ ...operation, state: 'QUEUED' });
        controller.dispose();
        expect(dialogs[0].destroy).toHaveBeenCalledOnce();
        await dialogs[0].confirm();
        expect(options.cancel).not.toHaveBeenCalled();
    });

    it('Уничтожает подтверждение после выхода, пока отправленная отмена ещё ожидает ответ', async () => {
        const pending=deferred<IOperationActionResult>();const {controller,options,dialogs,setUser}=setup();
        options.cancel.mockReturnValueOnce(pending.promise);controller.cancel({...operation,state:'QUEUED'});
        const request=dialogs[0].confirm();setUser(null);controller.dispose();
        expect(dialogs[0].destroy).toHaveBeenCalledOnce();pending.resolve({operationId:operation.operationId,state:'CANCELLED',message:'cancelled fixture'});await request;
        expect(options.success).not.toHaveBeenCalled();expect(options.reload).not.toHaveBeenCalled();
    });

    it('Не создаёт два подтверждения и два запроса отмены для одного задания', async () => {
        const pending = deferred<IOperationActionResult>();
        const { controller, options, dialogs } = setup();
        const queued = { ...operation, state: 'QUEUED' } as IOperation;
        options.cancel.mockReturnValueOnce(pending.promise);
        controller.cancel(queued);
        controller.cancel(queued);
        expect(dialogs).toHaveLength(1);
        const request = dialogs[0].confirm();
        await dialogs[0].confirm();
        controller.cancel(queued);
        expect(options.cancel).toHaveBeenCalledTimes(1);
        expect(dialogs).toHaveLength(1);
        pending.resolve({operationId:operation.operationId,state:'CANCELLED',message:'cancelled fixture'});
        await request;
        expect(options.success).toHaveBeenCalledWith('cancelled fixture');
    });

    it('Завершение прежней отмены не удаляет новое подтверждение после повторного монтирования', async () => {
        const pending=deferred<IOperationActionResult>();const {controller,options,dialogs}=setup();
        const queued={...operation,state:'QUEUED'} as IOperation;
        options.cancel.mockReturnValueOnce(pending.promise);controller.cancel(queued);
        const request=dialogs[0].confirm();controller.dispose();controller.activate();controller.cancel(queued);
        pending.resolve({operationId:operation.operationId,state:'CANCELLED',message:'cancelled fixture'});await request;controller.cancel(queued);
        expect(dialogs).toHaveLength(2);expect(options.success).not.toHaveBeenCalled();
        controller.dispose();expect(dialogs[1].destroy).toHaveBeenCalledOnce();
    });

    it('Отказ сервера для уже начатой работы не выдаётся за успешную отмену', async () => {
        const { controller, options, dialogs } = setup();
        options.cancel.mockRejectedValueOnce(new Error('MCP уже принял задание или оно завершено.'));
        controller.cancel({ ...operation, state: 'QUEUED' });
        await dialogs[0].confirm();
        expect(options.success).not.toHaveBeenCalled();
        expect(options.error).toHaveBeenCalledWith('MCP уже принял задание или оно завершено.');
    });

    it('Ошибка перечитывания после успешного POST не сообщает об ошибке повтора и не сохраняет его ключ', async () => {
        const { controller, options } = setup();
        options.reload.mockRejectedValueOnce(new Error('Не удалось прочитать список'));
        await controller.retry(operation);
        await controller.retry(operation);
        expect(options.retry.mock.calls.map(call => call[1])).toEqual(['key-first', 'key-next']);
        expect(options.success).toHaveBeenCalledTimes(2);
        expect(options.error).toHaveBeenCalledWith('Не удалось прочитать список');
    });

    it('Не выполняет действия чужого пользователя и записи без действующей роли', async () => {
        const { controller, options, setUser } = setup();
        await controller.retry({ ...operation, actor: 'other@example.test' });
        controller.cancel({ ...operation, actor: 'other@example.test', state: 'QUEUED' });
        setUser({ ...user, userRoles: [] });
        await controller.retry(operation);
        controller.cancel({ ...operation, state: 'QUEUED' });
        expect(options.retry).not.toHaveBeenCalled();
        expect(options.confirmCancel).not.toHaveBeenCalled();
    });

    it('Старое подтверждение не затрагивает новое после повторного монтирования', async () => {
        const { controller, options, dialogs } = setup();
        const queued = { ...operation, state: 'QUEUED' } as IOperation;
        controller.cancel(queued);
        controller.dispose();
        controller.activate();
        controller.cancel(queued);
        dialogs[0].close();
        controller.cancel(queued);
        expect(dialogs).toHaveLength(2);
        await dialogs[0].confirm();
        expect(options.cancel).not.toHaveBeenCalled();
        await dialogs[1].confirm();
        expect(options.cancel).toHaveBeenCalledOnce();
    });
});

describe('Ответ отмены показывает фактический исход исполнителя', () => {
    const roleOperation: IOperation = {
        ...operation, operationId: 'system-role-' + operation.resourceId, resourceType: 'system-role',
        state: 'RUNNING', bridgeJob: undefined,
        actions: {executor: 'system-role', digest: operation.actions!.digest, retry: {supported: false}, cancel: {supported: true}},
    };

    it.each([
        {state: 'FAILED', message: 'Исполнитель завершился с ошибкой', notification: 'error', expected: 'Исполнитель завершился с ошибкой'},
        {state: 'FAILED', message: '', notification: 'error', expected: 'Задание завершилось с ошибкой до отмены.'},
        {state: 'SUCCEEDED', message: 'Результат сохранён', notification: 'info', expected: 'Задание завершилось до отмены. Результат сохранён'},
        {state: 'SUCCEEDED', message: '', notification: 'info', expected: 'Задание завершилось до отмены.'},
        {state: 'CANCELLED', message: 'Отмена сохранена исполнителем', notification: 'success', expected: 'Отмена сохранена исполнителем'},
        {state: 'CANCELLED', message: '', notification: 'success', expected: 'Отмена задания подтверждена.'},
    ] as const)('Отложенный $state с сообщением «$message» получает только $notification', async result => {
        const pending = deferred<IOperationActionResult>();
        const {controller, options, dialogs, busy} = setup();
        options.cancel.mockReturnValueOnce(pending.promise);
        controller.cancel(roleOperation);
        const request = dialogs[0].confirm();
        expect(busy()).toEqual([roleOperation.operationId]);
        expect(options.reload).not.toHaveBeenCalled();
        pending.resolve({operationId: roleOperation.operationId, state: result.state, message: result.message});
        await request;
        expect(options[result.notification]).toHaveBeenCalledExactlyOnceWith(result.expected);
        for (const channel of ['success', 'error', 'info'] as const) {
            if (channel !== result.notification) expect(options[channel]).not.toHaveBeenCalled();
        }
        expect(options.cancel).toHaveBeenCalledExactlyOnceWith(roleOperation.operationId, 'key-first', roleOperation.actions!.digest);
        expect(options.reload).toHaveBeenCalledOnce();
        expect(busy()).toEqual([]);
    });

    it.each(['QUEUED', 'RUNNING'] as const)('Отмена сборки с ответом %s остаётся неподтверждённой до остановки worker', async state => {
        const pending = deferred<IOperationActionResult>();
        const main = {...user, activeRole: 'Главный админ', userRoles: ['Главный админ']};
        const {controller, options, dialogs, busy} = setup(main);
        const build: IOperation = {...roleOperation, operationId: 'tool-build-' + operation.resourceId, resourceType: 'tool-build', projectId: null,
            actions: {...roleOperation.actions!, executor: 'tool-build'}};
        options.cancel.mockReturnValueOnce(pending.promise);
        controller.cancel(build);
        const request = dialogs[0].confirm();
        pending.resolve({operationId: build.operationId, state, message: 'Останавливаем worker'});
        await request;
        expect(options.info).toHaveBeenCalledExactlyOnceWith('Отмена ещё не подтверждена. Останавливаем worker');
        expect(options.success).not.toHaveBeenCalled();
        expect(options.error).not.toHaveBeenCalled();
        expect(options.cancel).toHaveBeenCalledOnce();
        expect(options.reload).toHaveBeenCalledOnce();
        expect(busy()).toEqual([]);
    });

    it.each(['FAILED', 'SUCCEEDED', 'RUNNING', 'CANCELLED'] as const)('Запоздалый %s после смены владельца не показывает уведомления', async state => {
        const pending = deferred<IOperationActionResult>();
        const {controller, options, dialogs, setUser} = setup();
        options.cancel.mockReturnValueOnce(pending.promise);
        controller.cancel(roleOperation);
        const request = dialogs[0].confirm();
        setUser({...user, id: 'other', email: 'other@example.test'});
        const busyChanges = options.onBusyChange.mock.calls.length;
        pending.resolve({operationId: roleOperation.operationId, state, message: 'Ответ прежнего владельца'});
        await request;
        expect(options.success).not.toHaveBeenCalled();
        expect(options.error).not.toHaveBeenCalled();
        expect(options.info).not.toHaveBeenCalled();
        expect(options.reload).not.toHaveBeenCalled();
        expect(options.cancel).toHaveBeenCalledOnce();
        expect(options.onBusyChange).toHaveBeenCalledTimes(busyChanges);
    });
});
