import type { IAgentStatus } from './model';
import type { ICatalogAgent, IProjectAgent } from './types';

export interface IAgentUpdate { catalogNewer: boolean; needsApply: boolean; attention: boolean; }

/** Новая редакция шаблона и неподтверждённое применение — отдельные состояния. */
export function agentUpdate(agent: ICatalogAgent, assignment: IProjectAgent | undefined, status: IAgentStatus | undefined, ready: boolean): IAgentUpdate {
    const active = !!assignment && !assignment.removed;
    return {
        catalogNewer: ready && active && !agent.archivedAt && agent.version > assignment.version,
        needsApply: !!assignment && !!status && ['unapplied', 'error', 'pending'].includes(status.key),
        attention: !!status && ['pending', 'error'].includes(status.key),
    };
}

/** Фильтр не прячет применение, ошибку и удаление, ожидающее выбранного компьютера. */
export const showAgentUpdate = (update: IAgentUpdate): boolean => update.catalogNewer || update.needsApply || update.attention;
