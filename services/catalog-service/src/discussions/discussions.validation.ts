import { BadRequestException } from '@nestjs/common';
import type { DiscussionTarget } from './discussions.types';
export function discussionObject(value: unknown, keys: string[]): Record<string, unknown> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key))
    )
        throw new BadRequestException('Некорректные поля запроса.');
    return value as Record<string, unknown>;
}
export function discussionUuid(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value))
        throw new BadRequestException('Нужен UUID запроса или вложения.');
    return value.toLowerCase();
}
export function discussionVersion(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1)
        throw new BadRequestException('Передайте версию комментария.');
    return Number(value);
}
export function discussionTarget(type: unknown, id: unknown): DiscussionTarget {
    if (
        !['catalog', 'help'].includes(String(type)) ||
        typeof id !== 'string' ||
        !id ||
        id.length > 600 ||
        /[\x00-\x20\x7f]/.test(id)
    )
        throw new BadRequestException('Выберите карточку или статью.');
    if (
        (type === 'help' && !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(id)) ||
        (type === 'catalog' && !/^(?:mcp|plugin|skill|agent|model):[^:]+$/.test(id))
    )
        throw new BadRequestException('Некорректный адрес обсуждения.');
    return { type: type as DiscussionTarget['type'], id };
}
export function discussionBody(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16000 || /\x00/.test(value))
        throw new BadRequestException('Напишите комментарий до 16 КиБ.');
    return value.trim();
}
export function discussionAttachmentIds(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 5) throw new BadRequestException('Можно приложить до пяти файлов.');
    const ids = value.map(discussionUuid);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Вложение повторяется.');
    return ids;
}
