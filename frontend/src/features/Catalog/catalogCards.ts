import type { IAiPlugin, ISkillListSummary } from '../../core/api/interfaces';
import type { IStoreApp } from './types';

/** Маппинг MCP/плагина каталога в карточку витрины. */
export const fromPlugin = (p: IAiPlugin): IStoreApp => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    description: p.description,
    version: p.version,
    tags: p.tags,
    origin: p.origin,
    revision: p.revision,
    config: (p.config ?? undefined) as Record<string, unknown> | undefined,
    files: (p.files ?? []).map(f => ({ path: f.path, content: f.content })),
});

/** Маппинг скилла каталога в карточку витрины. */
export const fromSkill = (s: ISkillListSummary): IStoreApp => ({
    id: s.path,
    name: s.meta.name || s.path.split('/').pop() || s.path,
    kind: 'skill',
    description: s.meta.description ?? '',
    version: s.meta.version ?? 1,
    tags: s.meta.tags ?? [],
    origin: s.meta.slug ?? s.path,
    path: s.path,
    skillSlug: s.meta.slug,
});

