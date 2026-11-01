import type { IProjectDetail, IProjectSummary } from '../../../core/api/interfaces';
import type { IProjectLoadError } from '../interfaces';

/** Contract owned by reducers. */
export interface IProjectsState {
    list: IProjectSummary[];
    page: number;
    size: number;
    total: number;
    query: string;
    loading: boolean;
    listError: IProjectLoadError | null;
    listRequestId: string | null;
    authScope: string | null;
    authRequestId: string | null;

    selectedId: string | null;
    selected: IProjectDetail | null;
    selectedLoading: boolean;
    selectedRequestId: string | null;
    selectedError: IProjectLoadError | null;
}
