import { BadRequestException } from '@nestjs/common';
import { normalizeAgentDefinition, type AgentDefinition } from '../../../shared/project-agents.cjs';
import { publicationHash } from '../publication/publication-validation';
import type { AgentOverrides, AgentCard, AgentHeadRow } from './agent.types';
export const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function agentId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^agent-[a-z0-9][a-z0-9-]{0,120}$/.test(value))
        throw new BadRequestException('Выберите агента каталога.');
}
export function object(value: unknown, fields: string[]): Record<string, unknown> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !fields.includes(key))
    )
        throw new BadRequestException('Передайте только поддерживаемые поля агента.');
    return value as Record<string, unknown>;
}
export function request(value: unknown): asserts value is string {
    if (!uuid(value)) throw new BadRequestException('Передайте ключ запроса для безопасного повтора.');
}
export function revision(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new BadRequestException('Передайте актуальную ревизию проекта.');
}
export function normalizeDefinition(value: unknown): AgentDefinition {
    try {
        return normalizeAgentDefinition(value);
    } catch (error) {
        throw new BadRequestException(
            error instanceof Error ? error.message : 'Некорректный промпт или настройки агента.',
        );
    }
}
export function normalizeCard(raw: unknown): { slug: string; name: string; definition: AgentDefinition } {
    const input = object(raw, ['slug', 'name', 'description', 'definition']);
    if (typeof input.slug !== 'string' || input.slug.length > 64 || !/^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug))
        throw new BadRequestException(
            'Имя OpenCode должно начинаться с nc- и содержать только латиницу, цифры и дефисы.',
        );
    if (
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.length > 128 ||
        Buffer.from(input.name, 'utf8').toString('utf8') !== input.name ||
        /[\x00-\x1f\x7f]/.test(input.name)
    )
        throw new BadRequestException('Название агента должно содержать от 1 до 128 символов.');
    const definition = object(input.definition, [
        'description',
        'prompt',
        'mode',
        'model',
        'temperature',
        'topP',
        'steps',
        'permission',
    ]);
    if (
        input.description !== undefined &&
        definition.description !== undefined &&
        input.description !== definition.description
    )
        throw new BadRequestException('Описание карточки и промпта должно совпадать.');
    return {
        slug: input.slug,
        name: input.name.trim(),
        definition: normalizeDefinition({
            ...definition,
            ...(input.description === undefined ? {} : { description: input.description }),
        }),
    };
}
/** Omission inherits the pinned template; explicit null removes a model parameter. */
export function effectiveDefinition(
    base: AgentDefinition,
    raw: unknown,
): { overrides: AgentOverrides; effective: AgentDefinition } {
    const input = object(raw, ['description', 'prompt', 'mode', 'model', 'temperature', 'topP', 'steps', 'permission']),
        merged: Record<string, unknown> = { ...base, ...input };
    for (const key of ['model', 'temperature', 'topP', 'steps']) if (merged[key] === null) delete merged[key];
    return { overrides: structuredClone(input) as AgentOverrides, effective: normalizeDefinition(merged) };
}
export const agentManifest = (card: {
    id: string;
    slug: string;
    name: string;
    definition: AgentDefinition;
    version: number;
}): string =>
    publicationHash({
        id: card.id,
        slug: card.slug,
        name: card.name,
        definition: card.definition,
        version: card.version,
    });
export const agentNativeHash = (card: AgentCard): string =>
    publicationHash({
        id: card.id,
        slug: card.slug,
        name: card.name,
        definition: card.definition,
        version: card.version,
        archived: !!card.archivedAt,
    });
const date = (value: string | Date) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
export function agentCard(row: AgentHeadRow): AgentCard {
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.definition.description,
        definition: normalizeDefinition(row.definition),
        version: Number(row.version),
        manifest: row.manifest,
        archivedAt: row.archived_at ? date(row.archived_at) : null,
        createdAt: date(row.created_at),
        updatedAt: date(row.updated_at),
    };
}
