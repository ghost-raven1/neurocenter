import type { ReactNode } from 'react';
import type { IAgentStatus } from '../model';
import type { ICatalogAgent, IProjectAgent } from '../interfaces';
import type { IAgentReadinessItem } from '../readinessInterfaces';

/** Component inputs. */
export interface IAgentCardProps {
    agent: ICatalogAgent;
    assignment?: IProjectAgent;
    status?: IAgentStatus;
    projectSelected: boolean;
    isMain: boolean;
    canManage: boolean;
    busy: boolean;
    unavailable: boolean;
    onView: () => void;
    onEdit: () => void;
    onArchived: () => void;
    onAssign: () => void;
    onConfigure: () => void;
    onToggle: () => void;
    onRemove: () => void;
    onUpdate: () => void;
    readiness?: IAgentReadinessItem;
    trialDisabled?: boolean;
    trialChecking?: boolean;
    onTrial?: () => void;
    feedback?: ReactNode;
}
