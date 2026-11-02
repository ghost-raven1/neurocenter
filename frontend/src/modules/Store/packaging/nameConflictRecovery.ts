import { isAxiosError } from 'axios';
import { packagingApi } from './api';
import type { IBuildPublicationConflict } from './api.interfaces';

/** 409 занятости названия: структурированный ответ сервера либо null, если сервер его не вернул. */
export interface IBuildNameConflict {
    name: string;
    kind: string;
    target: { catalogId: string; kind: 'mcp' | 'plugin'; archived: boolean } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 409 при создании без цели обновления — только конфликт названия: сервер проверяет его до создания задания.
 * Структурированный payload {code:'name-conflict', catalogId, kind, archived}, когда присутствует,
 * указывает карточку напрямую; без него цель ищется отдельным запросом.
 */
export function readBuildNameConflict(
    cause: unknown,
    request: { name: string; kind: string; publication?: unknown },
): IBuildNameConflict | null {
    if (!isAxiosError(cause) || cause.response?.status !== 409) return null;
    const data = isRecord(cause.response?.data) ? cause.response.data : {};
    const kind: 'mcp' | 'plugin' | null = data.kind === 'mcp' ? 'mcp' : data.kind === 'plugin' ? 'plugin' : null;
    const target =
        data.code === 'name-conflict' && typeof data.catalogId === 'string' && kind
            ? { catalogId: data.catalogId, kind, archived: data.archived === true }
            : null;
    // Без payload конфликт названия возможен только у создания без цели обновления; скиллы проверку не проходят.
    if (!target && (request.publication !== undefined || request.kind === 'skill')) return null;
    return { name: request.name, kind: request.kind, target };
}

/** undefined — проверка недоступна, отказ POST обработает восстановление после 409. */
export async function lookupNameConflict(
    name: string,
    signal?: AbortSignal,
): Promise<IBuildPublicationConflict | null | undefined> {
    try {
        return (await packagingApi.publicationConflict(name, signal)) ?? null;
    } catch {
        return undefined;
    }
}

export type TNameConflictOutcome =
    | { state: 'unknown' }
    | { state: 'available' }
    | { state: 'archived' }
    | { state: 'other-kind' }
    | { state: 'match'; catalogId: string; kind: 'mcp' | 'plugin' };

export function classifyNameConflict(
    conflict: IBuildPublicationConflict | null | undefined,
    kind: string | undefined,
): TNameConflictOutcome {
    if (conflict === undefined) return { state: 'unknown' };
    if (!conflict) return { state: 'available' };
    if (conflict.archived) return { state: 'archived' };
    if (conflict.kind !== kind) return { state: 'other-kind' };
    return { state: 'match', catalogId: conflict.catalogId, kind: conflict.kind };
}

/** Сообщения общи для живой проверки и восстановления после 409. */
export const nameConflictMessages: Record<'archived' | 'other-kind' | 'match', string> = {
    archived:
        'Инструмент с этим названием находится в архиве. Верните карточку из архива или укажите другое название; исходники сохранены.',
    'other-kind': 'Это название занято инструментом другого типа. Укажите другое название; исходники сохранены.',
    match: 'Название уже занято. Подтвердите новую версию или укажите другое название; исходники сохранены в форме.',
};
