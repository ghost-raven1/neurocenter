import type { SystemRoleId } from '../SystemRoles/types';

/** A task belongs to one existing chat; its private role results stay owned by its initiator. */
export interface ChatRoleOrigin {kind: 'model-chat' | 'project-chat'; originId: string; projectId: string | null;}
export interface ChatRoleLaunch {key: number; origin: string; agentId: SystemRoleId; instruction: string; modelId?: string; onAccepted?: () => void;}
export const chatRoleOriginKey = (origin: ChatRoleOrigin): string => JSON.stringify([origin.kind, origin.originId, origin.projectId]);
