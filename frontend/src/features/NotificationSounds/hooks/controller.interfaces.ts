import type { ISoundPreference } from '../interfaces';

/** Contract owned by controller. */
export interface ISoundState extends ISoundPreference {
    principal: string;
    status: 'ready' | 'blocked' | 'unsupported';
    busy: boolean;
    persisted: boolean;
}
