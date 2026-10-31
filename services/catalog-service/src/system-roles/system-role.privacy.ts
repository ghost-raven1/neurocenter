import { ConflictException } from '@nestjs/common';
import { roleObject } from './system-role.validation';

const reserved = /\[NC_PRIVATE_[0-9]+\]/g;
const privateKey = /(?:api.?key|token|secret|password|authorization|credential|headers|^env$)/i;
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
export interface PrivateProjection {
    content: string;
    slots: Record<string, unknown>;
    paths: Record<string, string[]>;
}
/** Unknown JSON string values remain local; explicit text selections hide credential-bearing lines/tokens. */
export function roleProjection(
    value: string | Record<string, unknown>,
    json = false,
    visibleStrings: readonly string[] = [],
): PrivateProjection {
    if (JSON.stringify(value).match(reserved))
        throw new ConflictException('Выбранный текст содержит зарезервированный маркер приватности.');
    const slots: Record<string, unknown> = {},
        paths: Record<string, string[]> = {};
    const hide = (item: unknown, path: string[]): string => {
        const key = '[NC_PRIVATE_' + (Object.keys(slots).length + 1) + ']';
        slots[key] = item;
        paths[key] = path;
        return key;
    };
    if (!json) {
        const content = String(value)
            .split('\n')
            .map((line) =>
                (privateKey.test(line) && /[:=]/.test(line)) || /\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+\S+)/.test(line)
                    ? hide(line, [])
                    : line,
            )
            .join('\n');
        return { content, slots, paths };
    }
    const visit = (item: unknown, path: string[]): unknown => {
        if (
            privateKey.test(path[path.length - 1] ?? '') ||
            (typeof item === 'string' && !visibleStrings.includes(path.join('.')))
        )
            return hide(item, path);
        if (Array.isArray(item)) return item.map((child, index) => visit(child, [...path, String(index)]));
        if (roleObject(item))
            return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, [...path, key])]));
        return item;
    };
    return { content: JSON.stringify(visit(value, []), null, 2), slots, paths };
}
/** Private fragments must remain exactly once and at their original JSON path; the model cannot relocate credentials. */
export function restoreRoleProjection(content: string, projection: PrivateProjection, json = false): string {
    const markers = content.match(reserved) ?? [];
    if (
        markers.length !== Object.keys(projection.slots).length ||
        new Set(markers).size !== markers.length ||
        markers.some((key) => !owns(projection.slots, key))
    )
        throw new ConflictException('Предложение изменяет скрытые приватные значения.');
    if (!json) {
        const original = projection.content.split('\n'),
            proposed = content.split('\n');
        for (const marker of Object.keys(projection.slots))
            if (proposed.indexOf(marker) !== original.indexOf(marker))
                throw new ConflictException('Предложение переносит приватную строку.');
        return content.replace(reserved, (key) => String(projection.slots[key]));
    }
    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch {
        throw new ConflictException('Настройки должны остаться JSON-объектом.');
    }
    if (!roleObject(value)) throw new ConflictException('Настройки должны остаться JSON-объектом.');
    for (const [marker, path] of Object.entries(projection.paths)) {
        let selected: unknown = value;
        for (const key of path)
            selected =
                roleObject(selected) || Array.isArray(selected)
                    ? (selected as Record<string, unknown>)[key]
                    : undefined;
        if (selected !== marker) throw new ConflictException('Предложение переносит приватное поле настроек.');
    }
    const restore = (item: unknown): unknown =>
        typeof item === 'string' && owns(projection.slots, item)
            ? projection.slots[item]
            : Array.isArray(item)
              ? item.map(restore)
              : roleObject(item)
                ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, restore(child)]))
                : item;
    return JSON.stringify(restore(value));
}
