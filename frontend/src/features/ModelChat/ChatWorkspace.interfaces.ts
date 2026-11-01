import type { ReactNode } from 'react';
import type { IModelChatConversation } from './interfaces';
import type { IModelChatDetail } from './interfaces';

/** Contract owned by ChatWorkspace. */
export interface IChatWorkspaceNavigation {
    items: IModelChatConversation[];
    loading: boolean;
    opening?: boolean;
    error?: string;
    initialDetail?: IModelChatDetail;
    initialGroup?: boolean;
    controls: (request: (action: () => void) => void) => ReactNode;
    onSelect: (conversation: IModelChatConversation) => void;
    onRefresh: () => void;
    onChanged: (conversation: IModelChatConversation | null) => void;
}
