import type {
    IImageVersion,
    IProjectDetail,
    IProjectSummary,
} from '../../core/api/interfaces';

/** Ошибка чтения карточки: отсутствие/отказ доступа отличаются от временного сбоя. */
export interface IProjectLoadError {
    status: number | null;
    message: string;
}

/**
 * Состояние модуля Projects (список + карточка проекта + версии).
 */
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

    versions: IImageVersion[];
    versionsLoading: boolean;
    versionsProjectId: string | null;
    versionsRequestId: string | null;
}
