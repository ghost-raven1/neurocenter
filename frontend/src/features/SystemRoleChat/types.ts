import type { RolePrepared, RoleRun, RoleSelection, RoleStart, SystemRoleId } from '../SystemRoles/types';

export interface ServiceDialog { id: string; title: string; projectId: string | null; createdAt: string; updatedAt: string; }
export interface ServiceTurn { id: string; agentId: SystemRoleId; instruction: string; createdAt: string; cancelRequested: boolean; run: RoleRun | null; }
export interface ServiceDetail { dialog: ServiceDialog; turns: ServiceTurn[]; }
export interface ServicePreview { selection: RoleSelection; prepared: RolePrepared; }
export interface ServiceIntent { dialogId: string; agentId: SystemRoleId; input: RoleStart; }
export interface ServiceReceipt { dialogId: string; requestId: string; }
