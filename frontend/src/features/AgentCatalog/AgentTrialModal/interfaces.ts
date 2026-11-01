import type { IAgentReadinessItem, IAgentTrial, TAgentTrialTool } from '../readinessInterfaces';

/** Component inputs. */
export interface IAgentTrialModalProps {
    projectId: string;
    name: string;
    item: IAgentReadinessItem;
    busy: boolean;
    loading: boolean;
    error: string;
    uncertain: boolean;
    checking?: boolean;
    onClose: () => void;
    onRefresh: () => void;
    onReplay: () => void;
    onStart: (modelId: string, tool: TAgentTrialTool, consent: boolean) => void;
    onCancel: (trial: IAgentTrial) => void;
}
