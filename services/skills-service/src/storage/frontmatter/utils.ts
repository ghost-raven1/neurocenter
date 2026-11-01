import type { IHistoryEntry } from '../../skills/skills.model';

/** Read a nonempty legacy metadata string. */
export const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
/** Preserve legacy list coercion when reading stored metadata. */
export const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item)) : []);
/** Supply stable defaults for incomplete legacy history records. */
export const asHistory = (value: unknown): IHistoryEntry[] =>
    Array.isArray(value)
        ? value.map((entry) => {
              const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;

              return {
                  version: typeof item.version === 'number' ? item.version : 1,
                  at: typeof item.at === 'string' ? item.at : new Date(0).toISOString(),
                  author: typeof item.author === 'string' ? item.author : 'unknown',
                  note: asString(item.note),
              };
          })
        : [];
