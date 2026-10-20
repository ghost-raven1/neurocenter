import * as yaml from 'js-yaml';

import type { IHistoryEntry, ISkillMeta, ISkillResource, TScope } from '../skills/skills.model';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';

export const FRONTMATTER_DELIMITER = '---';

export interface IParsedSkillFile {
    meta?: Record<string, unknown>;
    body: string;
}

/**
 * Разбор содержимого `.md` на frontmatter (YAML) и markdown-тело.
 *
 * @param {string} raw - сырое содержимое файла
 * @returns {{ meta?: Record<string, unknown>, body: string }} frontmatter и тело
 */
export function parseSkillFile(raw: string): IParsedSkillFile {
    const normalized = raw.replace(/^\uFEFF/, '');

    if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
        return { body: normalized };
    }

    const closeIndex = normalized.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, 3);

    if (closeIndex === -1) {
        return { body: normalized };
    }

    const yamlSegment = normalized.slice(3, closeIndex);
    const body = normalized.slice(closeIndex + `\n${FRONTMATTER_DELIMITER}\n`.length);

    let meta: Record<string, unknown> | undefined;

    try {
        const parsed: unknown = yaml.load(yamlSegment);

        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            meta = parsed as Record<string, unknown>;
        }
    } catch {
        meta = undefined;
    }

    return { meta, body };
}

/**
 * Сборка содержимого `.md` из frontmatter (YAML) и тела.
 *
 * @param {ISkillMeta} meta - метаданные скилла
 * @param {string} body - markdown-тело
 * @returns {string} готовое содержимое файла
 */
export function serializeSkillFile(meta: ISkillMeta, body: string, resources?: ISkillResource[]): string {
    const yamlSegment = yaml.dump({ ...meta, ...(resources?.length ? { resources } : {}) }, { lineWidth: Number.MAX_SAFE_INTEGER, noRefs: true });

    return `${FRONTMATTER_DELIMITER}\n${yamlSegment}${FRONTMATTER_DELIMITER}\n${body}`;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map(item => String(item)) : []);
const asHistory = (value: unknown): IHistoryEntry[] =>
    (Array.isArray(value)
        ? value.map(entry => {
            const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;

            return {
                version: typeof item.version === 'number' ? item.version : 1,
                at: typeof item.at === 'string' ? item.at : new Date(0).toISOString(),
                author: typeof item.author === 'string' ? item.author : 'unknown',
                note: asString(item.note),
            };
        })
        : []);

/**
 * Нормализация распарсенного frontmatter в строгую модель, с дефолтами для отсутствующих полей.
 *
 * @param {Record<string, unknown>} raw - сырые данные frontmatter
 * @param {string} slug - slug скилла (basename пути)
 * @returns {ISkillMeta} валидная модель метаданных
 */
export function normalizeMeta(raw: Record<string, unknown>, slug: string): ISkillMeta {
    const scope: TScope = raw.scope === 'project' ? 'project' : 'common';
    const history = asHistory(raw.history);
    const version = typeof raw.version === 'number' ? raw.version : Math.max(1, ...(history.map(entry => entry.version)));
    const dependencies = normalizeDependencyPins(raw.dependencies);

    return {
        ...(asString(raw.generation) ? { generation: asString(raw.generation) } : {}),
        ...(asString(raw.archivedAt) ? {archivedAt:asString(raw.archivedAt)} : {}),
        ...(raw.assetArchive && typeof raw.assetArchive==='object' && typeof (raw.assetArchive as Record<string,unknown>).requestKey==='string'
            && typeof (raw.assetArchive as Record<string,unknown>).previousHash==='string' && typeof (raw.assetArchive as Record<string,unknown>).payloadHash==='string' && Number.isSafeInteger((raw.assetArchive as Record<string,unknown>).version)
            && typeof (raw.assetArchive as Record<string,unknown>).restore==='boolean' ? {assetArchive:raw.assetArchive as ISkillMeta['assetArchive']} : {}),
        ...(raw.assetImport && typeof raw.assetImport==='object' && !Array.isArray(raw.assetImport)
            && typeof (raw.assetImport as Record<string,unknown>).requestKey==='string' && typeof (raw.assetImport as Record<string,unknown>).payloadHash==='string'
            && Number.isSafeInteger((raw.assetImport as Record<string,unknown>).version) && Number((raw.assetImport as Record<string,unknown>).version)>0
            ? {assetImport:raw.assetImport as ISkillMeta['assetImport']} : {}),
        name: asString(raw.name) ?? slug,
        slug,
        scope,
        projectId: asString(raw.projectId),
        description: asString(raw.description),
        mcp: asList(raw.mcp),
        plugins: asList(raw.plugins),
        ...(dependencies.length ? { dependencies } : {}),
        specialization: asString(raw.specialization),
        tags: asList(raw.tags),
        version,
        owner: asString(raw.owner) ?? 'unknown',
        updatedAt: asString(raw.updatedAt) ?? new Date(0).toISOString(),
        history: history.length > 0 ? history : [{ version, at: new Date(0).toISOString(), author: 'unknown' }],
    };
}
