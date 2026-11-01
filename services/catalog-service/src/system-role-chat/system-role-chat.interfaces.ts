import type { IRoleRunView, IStartRoleRun, TSystemRoleId } from '../system-roles/system-role.interfaces';

export interface ISystemDialogRow {
    id: string;
    owner_email: string;
    project_id: string | null;
    title: string;
    agent_id?: TSystemRoleId | null;
    created_at: Date | string;
    updated_at: Date | string;
}
export interface ISystemTurnRow {
    id: string;
    dialog_id: string;
    owner_email: string;
    request_id: string;
    agent_id: TSystemRoleId;
    request_hash: string;
    input: IStartRoleRun;
    run_id: string;
    cancel_requested: boolean;
    created_at: Date | string;
}
export interface ISystemDialog {
    id: string;
    projectId: string | null;
    title: string;
    agentId?: TSystemRoleId | null;
    legacy?: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface ISystemTurn {
    id: string;
    agentId: TSystemRoleId;
    instruction: string;
    createdAt: string;
    cancelRequested: boolean;
    run: IRoleRunView;
}
