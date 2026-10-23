import type { IOperationDetail, TOperationState, TOperationType } from '../catalog/dto';

/** Актуальные назначения; собственное действие моста без проекта доступно его владельцу. */
export interface IOperationReadScope {
    projectIds: string[];
    actor: string;
}

export interface IOperationCreate {
    type: TOperationType;
    projectId?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    actor?: string | null;
    state?: TOperationState;
    percent?: number;
    error?: string | null;
    message?: string;
}

export interface IOperationStatePatch {
    percent?: number;
    error?: string | null;
    finishedAt?: string | null;
    clearError?: boolean;
    resetTimes?: boolean;
    logMessage?: string;
}

export interface IOperationRow {
    created_at: string;
    operation_id: string;
    type: string;
    project_id: string | null;
    resource_type: string;
    resource_id: string;
    actor: string;
    state: string;
    percent: number;
    bytes_done: number | string;
    bytes_total: number | string;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
    log: IOperationDetail['log'] | string | null;
    retries: number;
    system_role_agent_id?: string;
    system_role_phase?: string;
    bridge_job_kind?: string;
    bridge_job_project_exists?: boolean;
}
