import type { ICatalogModel } from '../ModelCatalog/interfaces';
import { modelChatUnavailableReason } from './model';

export type TChatModelSetupAction = 'assign' | 'provider' | 'check';

/**
 * Какие действия ведут от текущего состояния модели к готовности для чата.
 * Зеркалит порядок причин modelChatUnavailableReason: сначала назначение
 * проекту, затем провайдер/ключ, затем проверка. Проверку выполняет только
 * главный администратор (hosting control требует main), поэтому действие
 * выдаётся при canCheck; remote-модель завершается именно проверкой, а не
 * сохранением провайдера.
 */
export function chatModelSetupActions(
    model: ICatalogModel,
    assigned: boolean,
    canAssign: boolean,
    canCheck: boolean,
): { reason: string; actions: TChatModelSetupAction[]; hint: string } {
    const reason = modelChatUnavailableReason(model, true, true, assigned);
    if (!reason) return { reason: '', actions: [], hint: '' };
    if (model.capability === 'embedding')
        return { reason, actions: [], hint: 'Embedding-модели используются для поиска, а не для чата.' };
    if (!assigned)
        return {
            reason,
            actions: canAssign ? ['assign'] : [],
            hint: canAssign ? '' : 'Добавить модель в проект может администратор проекта.',
        };
    if (model.runtime !== 'ollama' && model.runtime !== 'device-codex' && !model.verificationSha256)
        return {
            reason,
            actions: canCheck ? ['provider', 'check'] : ['provider'],
            hint: canCheck ? '' : 'Проверку подключения после сохранения выполняет главный администратор.',
        };
    if (model.runtime === 'ollama' && !model.manifestSha256)
        return {
            reason,
            actions: canCheck ? ['check'] : [],
            hint: canCheck ? '' : 'Проверить модель на сервере может главный администратор.',
        };
    return { reason, actions: [], hint: '' };
}

/**
 * Когда показывать панель настройки прямо в чате: пользователь имеет доступ,
 * каталог прочитан, и ни одна модель в этом контексте не готова для чата.
 */
export function chatModelSetupVisible(params: {
    flagEnabled: boolean;
    canUse: boolean;
    loading: boolean;
    error: boolean;
    readyCount: number;
}): boolean {
    return params.flagEnabled && params.canUse && !params.loading && !params.error && params.readyCount === 0;
}
