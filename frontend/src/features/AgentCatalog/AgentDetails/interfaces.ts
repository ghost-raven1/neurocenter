import type { ICatalogAgent, IProjectAgent } from '../interfaces';
import type { IAgentReadinessItem } from '../readinessInterfaces';

/** Component inputs. */
export interface IAgentDetailsProps {
    agent: ICatalogAgent;
    assignment?: IProjectAgent;
    onClose: () => void;
    readiness?: IAgentReadinessItem;
    trialChecking?: boolean;
    onTrial?: () => void;
}
