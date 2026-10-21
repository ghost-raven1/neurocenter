import type { ICatalogModel } from '../ModelCatalog/types';
import type { IModelChatConversation, IModelChatDetail } from './types';

export function modelChatUnavailableReason(model: ICatalogModel, canUse: boolean, projectSelected: boolean, assigned: boolean): string {
    if (model.capability === 'embedding') return 'Embedding-модель предназначена для поиска, а не для диалога.';
    if (!canUse) return projectSelected ? 'Для чата нужна рабочая роль в выбранном проекте.' : 'Выберите проект, в котором вам доступна эта модель.';
    if (projectSelected && !assigned) return 'Сначала добавьте модель в выбранный проект.';
    if (model.archivedAt && !projectSelected) return 'Модель убрана из общего каталога.';
    if (model.runtime !== 'ollama' && !model.verificationSha256) return 'Сначала настройте API и проверьте подключение модели.';
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
/** Rendered model output cannot make automatic image requests or open executable URL schemes. */
export function modelChatUrl(value: string): string | undefined {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
    catch { return undefined; }
}
