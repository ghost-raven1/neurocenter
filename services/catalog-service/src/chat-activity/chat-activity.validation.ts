import { BadRequestException } from '@nestjs/common';
import { projectChatBody, projectChatUuid } from '../project-chat/project-chat.validation';

/** Bound both mutation and polling IDs before opening a database transaction. */
export function chatActivityMessageIds(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length > 100)
        throw new BadRequestException('Укажите до 100 просмотренных сообщений.');
    const values = raw.map(projectChatUuid);
    if (new Set(values).size !== values.length) throw new BadRequestException('Сообщения не должны повторяться.');
    return values;
}
export function chatActivityWatch(raw?: string): string[] {
    if (raw === undefined) return [];
    if (typeof raw !== 'string' || raw.length > 3699) throw new BadRequestException('Укажите до 100 сообщений.');
    return chatActivityMessageIds(raw.split(','));
}
export function chatActivitySession(raw: unknown, room = false) {
    const body = projectChatBody(raw, [
        'sessionId',
        'sequence',
        'online',
        ...(room ? ['typing', 'visibleMessageIds'] : []),
    ]);
    const sessionId = projectChatUuid(body.sessionId);
    if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1)
        throw new BadRequestException('Нужен порядковый номер сессии.');
    if (typeof body.online !== 'boolean' || (body.typing !== undefined && typeof body.typing !== 'boolean'))
        throw new BadRequestException('Передайте состояние сессии.');
    const visibleMessageIds =
        body.visibleMessageIds === undefined ? [] : chatActivityMessageIds(body.visibleMessageIds);
    if (!body.online && (body.typing === true || visibleMessageIds.length))
        throw new BadRequestException('Завершение сессии только очищает её активность.');
    return {
        sessionId,
        sequence: Number(body.sequence),
        online: body.online,
        typing: body.typing === true,
        visibleMessageIds,
    };
}
