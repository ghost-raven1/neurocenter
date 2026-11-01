import type { ICatalogAgent } from '../interfaces';

/** Component inputs. */
export interface IAgentEditModalProps {
    agent?: ICatalogAgent;
    onClose: () => void;
    onSaved: (agent: ICatalogAgent) => Promise<void>;
}
