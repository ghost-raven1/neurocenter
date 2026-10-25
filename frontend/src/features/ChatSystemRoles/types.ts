import type { SystemRoleId } from '../SystemRoles/types';
import type {ChatComposerAction} from '../ChatCommon/ChatSendAction';

/** A task belongs to one existing chat; its private role results stay owned by its initiator. */
export interface ChatRoleOrigin {kind: 'model-chat' | 'project-chat'; originId: string; projectId: string | null;}
export interface ChatRoleLaunch {key: number; origin: string; agentId: SystemRoleId; instruction: string; modelId?: string; onAccepted?: (instruction: string) => void;}
export type ChatRoleAction = ChatComposerAction;
export const chatRoleOriginKey = (origin: ChatRoleOrigin): string => JSON.stringify([origin.kind, origin.originId, origin.projectId]);
