import type { IAgentStatus } from '../model';

/** Visual statuses shared by the catalog cards. */
export const agentStatusColors: Record<IAgentStatus['key'], string | undefined> = {
    pending: 'blue',
    error: 'red',
    enabled: 'green',
    disabled: undefined,
    removed: undefined,
    unapplied: 'orange',
};
