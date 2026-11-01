export type TChatSystemRoleOriginKind = 'model-chat' | 'project-chat';
export interface IChatSystemRoleOrigin {
    kind: TChatSystemRoleOriginKind;
    originId: string;
    projectId: string | null;
}
export interface IChatSystemRoleOriginRow {
    dialog_id: string;
    owner_email: string;
    origin_kind: TChatSystemRoleOriginKind;
    origin_id: string;
    project_id: string | null;
}
