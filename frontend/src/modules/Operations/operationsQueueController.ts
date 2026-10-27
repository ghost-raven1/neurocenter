import { errorMessage } from '../../common/utils/errorMessage';
import type { IOperation, IOperationDetail, IOperationListParams, IOperationPage, TOperationState } from '../../core/api/interfaces';
import { operationReadStatus } from './operationReadFailure';

export interface IOperationsQueueSnapshot {
    list: IOperation[];
    page: number;
    size: number;
    total: number;
    state?: TOperationState;
    loading: boolean;
    error: string;
    updatedAt: string | null;
    selected: IOperationDetail | null;
    selectedId: string;
    detailLoading: boolean;
    detailError: string;
    accessDenied: boolean;
}

interface IOperationsQueueControllerOptions {
    projectId?: string;
    readList: (params: IOperationListParams) => Promise<IOperationPage>;
    readDetail: (id: string) => Promise<IOperationDetail>;
    onChange: (snapshot: IOperationsQueueSnapshot) => void;
}

export function initialOperationsQueueSnapshot(): IOperationsQueueSnapshot {
    return {
        list: [], page: 1, size: 10, total: 0, loading: false, error: '', updatedAt: null,
        selected: null, selectedId: '', detailLoading: false, detailError: '', accessDenied: false,
    };
}

/** Каждая очередь владеет запросами списка и деталей; поздний ответ не меняет новый экран. */
export function createOperationsQueueController(options: IOperationsQueueControllerOptions) {
    let active = false;
    let owner = 0;
    let listRequest = 0;
    let detailRequest = 0;
    let snapshot = initialOperationsQueueSnapshot();
    const update = (changes: Partial<IOperationsQueueSnapshot>): void => {
        snapshot = { ...snapshot, ...changes };
        options.onChange(snapshot);
    };

    const close = (): void => {
        detailRequest++;
        update({ selectedId: '', selected: null, detailError: '', detailLoading: false });
    };

    const denyAccess = (message: string, keepDetailOpen: boolean): void => {
        owner++;
        listRequest++;
        detailRequest++;
        update({ list: [], total: 0, updatedAt: null, loading: false, accessDenied: true,
            selected: null, selectedId: keepDetailOpen ? snapshot.selectedId : '',
            detailLoading: false, detailError: keepDetailOpen ? message : '', error: message });
    };

    const refreshDetail = async ({ skipIfPending = false }: { skipIfPending?: boolean } = {}): Promise<void> => {
        if (!active || !snapshot.selectedId || (skipIfPending && snapshot.detailLoading)) { return; }
        const id = snapshot.selectedId;
        const currentOwner = owner;
        const request = ++detailRequest;
        const isCurrent = (): boolean => active && owner === currentOwner && request === detailRequest;
        update({ detailLoading: true });
        try {
            const selected = await options.readDetail(id);
            if (isCurrent()) { update({ selected, detailError: '', accessDenied: false }); }
        } catch (failure) {
            if (isCurrent()) {
                const message = errorMessage(failure, 'Не удалось прочитать операцию.');
                const status = operationReadStatus(failure);
                if (status === 401 || status === 403) { denyAccess(message, true); }
                else { update({ detailError: message, ...(status === 404 ? { selected: null } : {}) }); }
            }
        } finally {
            if (isCurrent()) { update({ detailLoading: false }); }
        }
    };

    // Фоновый тик ждёт текущего чтения; явный повтор или новый фильтр вытесняют старое.
    const reload = async ({ skipIfPending = false }: { skipIfPending?: boolean } = {}): Promise<void> => {
        if (!active || (skipIfPending && snapshot.loading)) { return; }
        const { page, size, state } = snapshot;
        const currentOwner = owner;
        const request = ++listRequest;
        const isCurrent = (): boolean => active && owner === currentOwner && request === listRequest;
        update({ loading: true });
        try {
            const result = await options.readList({ page, size, projectId: options.projectId, state });
            if (!isCurrent()) { return; }
            const lastPage = Math.max(1, Math.ceil(result.total / size));
            if (page > lastPage) {
                update({ page: lastPage, total: result.total, list: [] });
                await reload();
                return;
            }
            update({ list: result.items, total: result.total, error: '', updatedAt: new Date().toISOString(), accessDenied: false });
        } catch (failure) {
            if (isCurrent()) {
                const message = errorMessage(failure, 'Не удалось загрузить операции.');
                const status = operationReadStatus(failure);
                if (status === 401 || status === 403) { denyAccess(message, false); }
                else { update({ error: message }); }
            }
        } finally {
            if (isCurrent()) { update({ loading: false }); }
        }
    };

    return {
        activate(): void {
            active = true;
            owner++;
            snapshot = initialOperationsQueueSnapshot();
            options.onChange(snapshot);
        },
        dispose(): void {
            active = false;
            owner++;
        },
        reload,
        refreshDetail,
        async setPage(page: number): Promise<void> {
            if (!active || page === snapshot.page) { return; }
            update({ page, list: [], error: '', updatedAt: null });
            await reload();
        },
        async setState(state?: TOperationState): Promise<void> {
            if (!active || state === snapshot.state) { return; }
            close();
            update({ state, page: 1, list: [], total: 0, error: '', updatedAt: null });
            await reload();
        },
        async select(id: string): Promise<void> {
            if (!active) { return; }
            detailRequest++;
            update({ selectedId: id, selected: null, detailError: '', detailLoading: false });
            await refreshDetail();
        },
        close(): void {
            if (active) { close(); }
        },
    };
}
