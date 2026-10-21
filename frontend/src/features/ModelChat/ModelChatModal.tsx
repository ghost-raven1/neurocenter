import type {IModelChatProps} from './types';
import {ChatWorkspace} from './ChatWorkspace';

/** Existing catalogue entry shares the same private chat workspace as the application header. */
export function ModelChatModal(props: IModelChatProps): JSX.Element {
    return <ChatWorkspace {...props}/>;
}
