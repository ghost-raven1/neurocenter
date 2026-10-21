import type { ICatalogModel } from '../ModelCatalog/types';
import type { IModelChatAnswer, IModelChatMessage, IModelChatTurn } from './types';

export const MODEL_CHAT_MAX_MESSAGES = 40;
export const MODEL_CHAT_MAX_MESSAGE_BYTES = 128 * 1024;
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const requestTooLarge = (messages: IModelChatMessage[]): boolean => bytes(JSON.stringify({ messages, stream: false })) > 8 * 1024 * 1024;

/** Metadata edits keep the conversation; changing model semantics requires an explicit new dialogue. */
export function modelChatIdentity(model: ICatalogModel): string {
    return JSON.stringify([model.id, model.runtime, model.model, model.modelVersion, model.capability, model.modelPin,
        model.runtime === 'ollama' ? model.manifestSha256 : model.verificationSha256]);
}

export function modelChatUnavailableReason(model: ICatalogModel, canUse: boolean, projectSelected: boolean, assigned: boolean): string {
    if (model.capability === 'embedding') return 'Embedding-модель предназначена для поиска, а не для диалога.';
    if (!canUse) return projectSelected ? 'Для чата нужна рабочая роль в выбранном проекте.' : 'Выберите проект, в котором вам доступна эта модель.';
    if (projectSelected && !assigned) return 'Сначала добавьте модель в выбранный проект.';
    if (model.archivedAt && !projectSelected) return 'Модель убрана из общего каталога.';
    if (model.runtime !== 'ollama' && !model.verificationSha256) return 'Сначала настройте API и проверьте подключение модели.';
    if (model.runtime === 'ollama' && !model.manifestSha256) return 'Сначала запустите или проверьте модель на сервере.';
    return '';
}

/** Every successful turn is retained; context is never silently truncated. */
export function modelChatMessages(turns: IModelChatTurn[]): IModelChatMessage[] {
    return turns.flatMap(turn => turn.status === 'done' && turn.answer
        ? [{ role: 'user' as const, content: turn.prompt }, { role: 'assistant' as const, content: turn.answer.content }]
        : [{ role: 'user' as const, content: turn.prompt }]);
}

export function modelChatPromptError(prompt: string, previous: IModelChatTurn[]): string {
    if (!prompt.trim()) return 'Введите сообщение.';
    if (bytes(prompt) > MODEL_CHAT_MAX_MESSAGE_BYTES) return 'Сообщение слишком большое: максимум 128 КиБ текста.';
    if (previous.some(turn => turn.status !== 'done')) return 'Повторите или измените последнее сообщение.';
    const contextError = modelChatContextError(previous);
    if (contextError) return contextError;
    return requestTooLarge([...modelChatMessages(previous), { role: 'user', content: prompt }]) ? 'Диалог превышает предел запроса 8 МиБ. Начните новый диалог.' : '';
}

export function modelChatContextError(previous: IModelChatTurn[]): string {
    const messages = modelChatMessages(previous);
    if (messages.length + 1 > MODEL_CHAT_MAX_MESSAGES) return 'Достигнут предел 40 сообщений. Начните новый диалог.';
    if (messages.some(message => bytes(message.content) > MODEL_CHAT_MAX_MESSAGE_BYTES)) return 'Ответ модели слишком большой для следующего запроса. Начните новый диалог.';
    if (requestTooLarge(messages)) return 'Диалог превышает предел запроса 8 МиБ. Начните новый диалог.';
    return '';
}

/** Provider content is data: accept only a complete, bounded assistant text response. */
export function modelChatAnswer(value: unknown, expectedModel: string): IModelChatAnswer {
    const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
    if (!object(value) || value.model !== expectedModel || !Array.isArray(value.choices) || value.choices.length !== 1) throw new Error('Модель вернула некорректный ответ. Повторите запрос.');
    const choice: unknown = value.choices[0];
    if (!object(choice) || choice.index !== 0 || !object(choice.message) || choice.message.role !== 'assistant'
        || typeof choice.message.content !== 'string' || !choice.message.content.trim() || bytes(choice.message.content) > 8 * 1024 * 1024
        || !['stop', 'length'].includes(String(choice.finish_reason))) throw new Error('Модель вернула некорректный ответ. Повторите запрос.');
    return { content: choice.message.content, finishReason: choice.finish_reason as IModelChatAnswer['finishReason'] };
}

/** Only ordinary external links can be opened; model images never make network requests. */
export function modelChatUrl(value: string): string | undefined {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
    catch { return undefined; }
}
