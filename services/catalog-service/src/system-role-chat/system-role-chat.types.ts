import type { RoleRunView, StartRoleRun, SystemRoleId } from '../system-roles/system-role.types';

export interface SystemDialogRow {
    id: string;
    owner_email: string;
    project_id: string | null;
    title: string;
    agent_id?: SystemRoleId | null;
    created_at: Date | string;
    updated_at: Date | string;
}
export interface SystemTurnRow {
    id: string;
    dialog_id: string;
    owner_email: string;
    request_id: string;
    agent_id: SystemRoleId;
    request_hash: string;
    input: StartRoleRun;
    run_id: string;
    cancel_requested: boolean;
    created_at: Date | string;
}
export interface SystemDialog {
    id: string;
    projectId: string | null;
    title: string;
    agentId?: SystemRoleId | null;
    legacy?: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface SystemTurn {
    id: string;
    agentId: SystemRoleId;
    instruction: string;
    createdAt: string;
    cancelRequested: boolean;
    run: RoleRunView;
}
