export type ChatSystemRoleOriginKind = 'model-chat' | 'project-chat';
export interface ChatSystemRoleOrigin {kind: ChatSystemRoleOriginKind; originId: string; projectId: string | null;}
export interface ChatSystemRoleOriginRow {dialog_id: string; owner_email: string; origin_kind: ChatSystemRoleOriginKind; origin_id: string; project_id: string | null;}
