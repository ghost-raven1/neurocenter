import type { IProjectChatMethodWorkflow } from './interfaces';
import type { IProjectChatMethodWorkflowHistory } from './interfaces';

/** Contract owned by api. */
export interface IProjectChatMethodWorkflowPage extends IProjectChatMethodWorkflowHistory {
    items: IProjectChatMethodWorkflow[];
}
