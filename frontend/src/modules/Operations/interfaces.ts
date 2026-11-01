import type { TOperationState, TOperationType } from '../../core/api/interfaces';

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
