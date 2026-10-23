import type { ICatalogModel } from '../ModelCatalog/types';
import type { IModelChatContext, IModelChatConversation, IModelChatDetail, IModelChatHistoryPage } from './types';

/** One participant's compressible history cannot conceal another participant's oversized new input. */
export function modelChatContextBlocked(context?: IModelChatContext): boolean {
    return context?.participants ? context.participants.some(item => item.context.exceeded && !item.context.canCompact) : !!context?.exceeded && !context.canCompact;
}

export function modelChatUnavailableReason(model: ICatalogModel, canUse: boolean, projectSelected: boolean, assigned: boolean): string {
    if (model.capability === 'embedding') return 'Embedding-модель предназначена для поиска, а не для диалога.';
    if (!canUse) return projectSelected ? 'Для чата нужна рабочая роль в выбранном проекте.' : 'Выберите проект, в котором вам доступна эта модель.';
    if (projectSelected && !assigned) return 'Сначала добавьте модель в выбранный проект.';
    if (model.archivedAt && !projectSelected) return 'Модель убрана из общего каталога.';
    if (model.runtime !== 'ollama' && model.runtime !== 'device-codex' && !model.verificationSha256) return 'Сначала настройте API и проверьте подключение модели.';
    if (model.runtime === 'ollama' && !model.manifestSha256) return 'Сначала запустите или проверьте модель на сервере.';
    return '';
}
export function modelChatPromptError(prompt: string, attachmentIds: string[], detail: IModelChatDetail | null): string {
    if (!prompt.trim() && !attachmentIds.length) return 'Введите сообщение или прикрепите документ.';
    if (new TextEncoder().encode(prompt).byteLength > 128 * 1024) return 'Сообщение слишком большое: максимум 128 КиБ текста.';
    if (detail?.turns.some(turn => turn.status !== 'done')) return 'Повторите или измените последнее сообщение.';
    return '';
}
export function sortedModelChats(items: IModelChatConversation[], selected?: IModelChatConversation): IModelChatConversation[] {
    const values = new Map(items.map(value => [value.id, value]));
    if (selected) values.set(selected.id, selected);
    return [...values.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
/** Fresh tail mutations retain the older pages already opened by this owner, without reviving removed drafts. */
export function mergeModelChatDetail(previous: IModelChatDetail | null, next: IModelChatDetail): IModelChatDetail {
    if (!previous || previous.conversation.id !== next.conversation.id || !next.turns.length) return next;
    const anchor = previous.turns.findIndex(turn => turn.id === next.turns[0].id);
    if (anchor <= 0) return next;
    const prefix = previous.turns.slice(0, anchor), used = new Set(prefix.flatMap(turn => turn.attachmentIds));
    const attachments = new Map([...previous.attachments.filter(file => used.has(file.id)), ...next.attachments].map(file => [file.id, file]));
    return {...next, turns: [...prefix, ...next.turns], history: previous.history, attachments: [...attachments.values()]};
}

/** Earlier pages add visible history only; the server remains responsible for inference context. */
export function prependModelChatHistory(current: IModelChatDetail, page: IModelChatHistoryPage): IModelChatDetail {
    const turns = new Map([...page.turns, ...current.turns].map(turn => [turn.id, turn]));
    const attachments = new Map([...page.attachments, ...current.attachments].map(file => [file.id, file]));
    return {...current, turns: [...turns.values()], attachments: [...attachments.values()], history: page.history};
}
/** Rendered model output cannot make automatic image requests or open executable URL schemes. */
export function modelChatUrl(value: string): string | undefined {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
    catch { return undefined; }
}
