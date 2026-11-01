import type { IRolePrepared, IRoleRun, IRoleSelection, IRoleStart, TSystemRoleId } from '../SystemRoles/interfaces';

export interface IServiceDialog {
    id: string;
    title: string;
    agentId?: TSystemRoleId | null;
    legacy?: boolean;
    projectId: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface IServiceTurn {
    id: string;
    agentId: TSystemRoleId;
    instruction: string;
    createdAt: string;
    cancelRequested: boolean;
    run: IRoleRun | null;
}
export interface IServiceDetail {
    dialog: IServiceDialog;
    turns: IServiceTurn[];
}
export interface IServicePreview {
    selection: IRoleSelection;
    prepared: IRolePrepared;
}
export interface IServiceIntent {
    dialogId: string;
    agentId: TSystemRoleId;
    input: IRoleStart;
}
export interface IServiceReceipt {
    dialogId: string;
    requestId: string;
}
