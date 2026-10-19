import type {
    IOperation,
    IOperationDetail,
    TOperationState,
    TOperationType,
} from '../../core/api/interfaces';

export interface IOperationsFilters {
    projectId?: string;
    type?: TOperationType;
    state?: TOperationState;
}

export interface IOperationProgressCache {
    percent: number;
    bytesDone: number;
    bytesTotal: number;
}

/**
 * Состояние модуля Operations (очередь передач/проверок + live-прогресс).
 */
export interface IOperationsState {
    list: IOperation[];
    page: number;
    size: number;
    total: number;
    activeCount:number;
    loading: boolean;
    filters: IOperationsFilters;
    progressCache: Record<string, IOperationProgressCache>;
    selected: IOperationDetail | null;
}
