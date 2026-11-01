import type { TSystemRoleId } from '../SystemRoles/interfaces';
import type { IChatComposerAction } from '../ChatCommon/ChatSendAction';

/** A task belongs to one existing chat; its private role results stay owned by its initiator. */
export interface IChatRoleOrigin {
    kind: 'model-chat' | 'project-chat';
    originId: string;
    projectId: string | null;
}

export interface IChatRoleLaunch {
    key: number;
    origin: string;
    agentId: TSystemRoleId;
    instruction: string;
    modelId?: string;
    onAccepted?: (instruction: string) => void;
}

export type TChatRoleAction = IChatComposerAction;
