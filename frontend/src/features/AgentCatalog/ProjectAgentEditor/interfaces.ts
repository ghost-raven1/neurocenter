import type { IAgentProjectPatch, ICatalogAgent, IProjectAgent } from '../interfaces';

/** Component inputs. */
export interface IProjectAgentEditorProps {
    projectId: string;
    assignment: IProjectAgent;
    revision: number;
    onClose: () => void;
    onSave: (agent: ICatalogAgent, patch: IAgentProjectPatch, revision: number) => Promise<unknown>;
}
