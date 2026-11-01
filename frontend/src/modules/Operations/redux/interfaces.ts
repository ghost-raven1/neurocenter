import type { IOperation, IOperationDetail } from '../../../core/api/interfaces';
import type { IOperationsFilters } from '../interfaces';
import type { IOperationProgressCache } from '../interfaces';

/** Contract owned by reducers. */
export interface IOperationsState {
    list: IOperation[];
    page: number;
    size: number;
    total: number;
    activeCount: number;
    loading: boolean;
    filters: IOperationsFilters;
    progressCache: Record<string, IOperationProgressCache>;
    selected: IOperationDetail | null;
}
