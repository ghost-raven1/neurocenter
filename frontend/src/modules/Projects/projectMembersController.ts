import { isAxiosError } from 'axios';
import type { IProjectMember } from '../../core/api/interfaces';

export interface IProjectMembersState {
    members: IProjectMember[];
    loading: boolean;
    loadError: boolean;
}

export const initialProjectMembersState = (): IProjectMembersState => ({ members: [], loading: true, loadError: false });

/** Публикует только последнее чтение сотрудников активного проекта и владельца. */
export function createProjectMembersController(options: {
    isOwnerCurrent: () => boolean;
    read: () => Promise<IProjectMember[]>;
    onChange: (state: IProjectMembersState) => void;
}) {
    let active = false;
    let generation = 0;
    let state = initialProjectMembersState();
    const update = (changes: Partial<IProjectMembersState>): void => {
        state = { ...state, ...changes };
        options.onChange(state);
    };
    return {
        activate(): void { active = true; generation++; state = initialProjectMembersState(); options.onChange(state); },
        dispose(): void { active = false; generation++; },
        async refresh(): Promise<void> {
            if (!active || !options.isOwnerCurrent()) { return; }
            const request = ++generation;
            const current = (): boolean => active && request === generation && options.isOwnerCurrent();
            update({ loading: true, loadError: false });
            try {
                const members = await options.read();
                if (current()) { update({ members }); }
            } catch (failure) {
                if (!current()) { return; }
                const denied = isAxiosError(failure) && [401, 403, 404].includes(failure.response?.status ?? 0);
                update({ loadError: true, ...(denied ? { members: [] } : {}) });
            } finally { if (current()) { update({ loading: false }); } }
        },
    };
}
