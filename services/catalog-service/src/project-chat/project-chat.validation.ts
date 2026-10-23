import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { chatAgentIds } from '../model-chat/chat-group';
import { chatBody, chatPin, chatRevision, chatUuid } from '../model-chat/chat-validation';
export { chatUuid as projectChatUuid, chatPin as projectChatPin, chatRevision as projectChatRevision, chatBody as projectChatBody };
export const projectChatHash = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
/** The body is stable for idempotent retries; sending never depends on the shared room revision. */
export function projectChatSend(raw: unknown) {
    const body = chatBody(raw, ['requestKey', 'prompt', 'replyToId', 'targetAgentIds']);
    const requestKey = chatUuid(body.requestKey);
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 131072 || /\x00/.test(body.prompt)) throw new BadRequestException('Введите сообщение до 128 КиБ.');
    const replyToId = body.replyToId === undefined ? null : chatUuid(body.replyToId);
    const targetAgentIds = body.targetAgentIds === undefined ? undefined : chatAgentIds(body.targetAgentIds, true);
    return { requestKey, prompt: body.prompt, replyToId, targetAgentIds,
        hash: projectChatHash({ prompt: body.prompt, replyToId, targetAgentIds: targetAgentIds ?? null }) };
}
export function projectChatParticipants(raw: unknown) {
    const body = chatBody(raw, ['expectedRevision', 'modelId', 'expectedModelPin', 'agentIds']);
    const expectedRevision = body.expectedRevision === 0 ? 0 : chatRevision(body.expectedRevision), agentIds = chatAgentIds(body.agentIds, true);
    if (body.modelId !== undefined && (typeof body.modelId !== 'string' || !body.modelId || body.modelId.length > 256)) throw new BadRequestException('Выберите модель из каталога проекта.');
    const modelId = body.modelId as string | undefined, modelPin = body.expectedModelPin === undefined ? undefined : chatPin(body.expectedModelPin);
    if ((modelId === undefined) !== (modelPin === undefined) || agentIds.length && !modelId) throw new BadRequestException('Для агентов выберите проверенную модель и её версию.');
    return { expectedRevision, agentIds, modelId: modelId ?? null, modelPin: modelPin ?? null };
}
export function projectChatPage(before?: string, rawLimit?: string) {
    if (before !== undefined) chatUuid(before);
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Размер страницы: от 1 до 50 сообщений.');
    return { before, limit };
}
/** Poll only a bounded set of known messages; arbitrary queries cannot enumerate other rooms. */
export function projectChatWatch(raw?: string): string[] {
    if (raw === undefined) return [];
    if (typeof raw !== 'string' || raw.length > 1849) throw new BadRequestException('Можно отслеживать до 50 сообщений.');
    const values = raw.split(',');
    if (values.length > 50) throw new BadRequestException('Укажите до 50 разных сообщений.');
    const ids = values.map(chatUuid);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Укажите до 50 разных сообщений.');
    return ids;
}
