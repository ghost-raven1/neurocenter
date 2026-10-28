import type { ISkillMeta } from '../../core/api/interfaces';

/** Legacy generations are bound to their first immutable history entry, as in skill storage. */
export const skillGenerationKey = (meta: ISkillMeta): string => meta.generation || JSON.stringify(meta.history?.[0] ?? null);
