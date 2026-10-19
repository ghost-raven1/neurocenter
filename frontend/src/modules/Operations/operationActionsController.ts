import { errorMessage } from '../../common/utils/errorMessage';
import type { IOperation } from '../../core/api/interfaces';
import type { IUserInfo } from '../../core/interfaces';
import type { IBridgeJob } from '../../features/McpBridge/api';

import { operationActionPermissions, operationActionScope } from './operationActions';

interface IControllerOptions {
    getUser: () => IUserInfo | null;
    retry: (jobId: string, requestKey: string) => Promise<IBridgeJob>;
    cancel: (jobId: string) => Promise<void>;
    reload: () => Promise<void>;
    confirmCancel: (confirm: () => Promise<void>, close: () => void) => { destroy: () => void };
    success: (text: string) => void;
    error: (text: string) => void;
    onBusyChange: (operationIds: ReadonlySet<string>) => void;
    requestKey: () => string;
}

/** Каждый запрос принадлежит аккаунту, назначениям и одному экземпляру очереди. */
export function createOperationActionsController(options: IControllerOptions) {
    const owner = operationActionScope(options.getUser());
    const pending = new Map<string, symbol>();
    const retryKeys = new Map<string, string>();
    const confirmations = new Map<string, { token: symbol; destroy: () => void }>();
    let active = false;
    let generation = 0;

    const isOwnerCurrent = (): boolean => active && owner === operationActionScope(options.getUser());
    const capture = (): (() => boolean) => {
        const epoch = generation;
        return () => isOwnerCurrent() && epoch === generation;
    };
    const publishBusy = (): void => {
        if (isOwnerCurrent()) { options.onBusyChange(new Set(pending.keys())); }
    };
    const start = (operationId: string): symbol => {
        const request = Symbol(operationId);
        pending.set(operationId, request);
        publishBusy();
        return request;
    };
    const finish = (operationId: string, request: symbol): void => {
        if (pending.get(operationId) === request) {
            pending.delete(operationId);
            publishBusy();
        }
    };
    const refresh = async (isCurrent: () => boolean): Promise<void> => {
        if (!isCurrent()) { return; }
        try { await options.reload(); }
        catch (failure) {
            if (isCurrent()) {
                options.error(errorMessage(failure, 'Действие выполнено, но не удалось обновить операции.'));
            }
        }
    };

    return {
        activate(): void {
            active = true;
            generation++;
            publishBusy();
        },
        dispose(): void {
            active = false;
            generation++;
            confirmations.forEach(confirmation => confirmation.destroy());
            confirmations.clear();
            pending.clear();
            retryKeys.clear();
        },
        async retry(operation: IOperation): Promise<void> {
            const isCurrent = capture();
            const id = operation.operationId;
            if (!isCurrent() || !operationActionPermissions(operation, options.getUser()).retry
                || pending.has(id) || confirmations.has(id)) { return; }

            const request = start(id);
            try {
                const key = retryKeys.get(id) ?? options.requestKey();
                retryKeys.set(id, key);
                const job = await options.retry(operation.resourceId, key);
                // Ответ подтверждает результат; ошибка следующего GET не должна повторять POST с тем же ключом.
                if (pending.get(id) === request && retryKeys.get(id) === key) { retryKeys.delete(id); }
                if (!isCurrent()) { return; }
                if (job.state === 'failed') {
                    options.error(job.message || 'Повторное задание завершилось с ошибкой.');
                } else {
                    options.success(['queued', 'running'].includes(job.state)
                        ? 'Новое задание передано мосту' : 'Повторное задание уже завершено');
                }
                await refresh(isCurrent);
            } catch (failure) {
                if (isCurrent()) { options.error(errorMessage(failure, 'Не удалось повторить задание.')); }
            } finally {
                finish(id, request);
            }
        },
        cancel(operation: IOperation): void {
            const isCurrent = capture();
            const id = operation.operationId;
            if (!isCurrent() || !operationActionPermissions(operation, options.getUser()).cancel
                || pending.has(id) || confirmations.has(id)) { return; }

            const token = Symbol(id);
            const close = (): void => {
                if (confirmations.get(id)?.token === token) { confirmations.delete(id); }
            };
            const confirmation = options.confirmCancel(async () => {
                if (pending.has(id)) { return; }
                if (!isCurrent() || !operationActionPermissions(operation, options.getUser()).cancel) { close(); return; }
                const request = start(id);
                try {
                    // Сервер отменяет атомарно только QUEUED; уже начатая работа вернёт отказ.
                    await options.cancel(operation.resourceId);
                    if (!isCurrent()) { return; }
                    options.success('Задание в очереди отменено');
                    await refresh(isCurrent);
                } catch (failure) {
                    if (isCurrent()) { options.error(errorMessage(failure, 'Не удалось отменить задание.')); }
                } finally {
                    finish(id, request);
                    close();
                }
            }, close);
            confirmations.set(id, { ...confirmation, token });
        },
    };
}
