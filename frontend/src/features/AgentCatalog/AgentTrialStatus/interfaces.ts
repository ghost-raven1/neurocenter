import type { IAgentReadinessItem } from '../readinessInterfaces';

/** Component inputs. */
export interface IAgentTrialStatusProps {
    item: IAgentReadinessItem;
    checking?: boolean;
}
