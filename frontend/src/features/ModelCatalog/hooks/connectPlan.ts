import { personalProviderApi } from '../../RemoteProviderAccess/api';
import type { IProjectReindexPlan } from '../../ProjectEmbedding/reindex';
import { modelCatalogApi } from '../api';
import type { ICatalogModel } from '../interfaces';
import { modelUsesApiConnection } from '../modelCatalogState';
import type { TConnectStep } from './useConnectSequence';

export const connectFailedLabel = 'Не удалось подключить модель. Повторите попытку.';

/**
 * Адаптивный первый шаг единого потока подключения (8.19 P1-1, OQ-8):
 * модель без серверного подключения идёт сразу в шаг «Готовность», без общего
 * адреса — в шаг «Подключение», при личном ключе провайдера — в шаг «Ключ».
 * Главный администратор читает общее подключение, остальные — «Мой доступ»;
 * без доступного взгляда операция подключения выполняется напрямую.
 */
export async function planConnectStep(model: ICatalogModel, isMain: boolean): Promise<TConnectStep> {
    if (!modelUsesApiConnection(model)) return 'run';
    if (isMain) {
        const view = await modelCatalogApi.connection(model.id);
        if (!view.baseUrl) return 'connection';
        return view.authMode !== 'none' ? 'access' : 'run';
    }
    try {
        const view = await personalProviderApi.read(model.id);
        return view.authMode !== 'none' ? 'access' : 'run';
    } catch {
        return 'run';
    }
}

/**
 * Наблюдение шага «Готовность»: подключение подтверждено, когда выбор модели
 * совпадает с целью; сбой — по плану или локальному заданию этой модели.
 * Преходящие ошибки чтения не ломают запущенную операцию.
 */
export function observeConnectRun(
    model: ICatalogModel,
    context: { connected: boolean; plan?: IProjectReindexPlan; reindexError?: string; pending: boolean },
): { state: 'running' | 'ready' | 'failed'; message?: string } {
    if (context.connected) return { state: 'ready' };
    const plan = context.plan;
    if (plan && plan.data.modelId === model.id) {
        if (['failed', 'stale'].includes(plan.state))
            return { state: 'failed', message: plan.message || connectFailedLabel };
        if (plan.local && ['failed', 'cancelled'].includes(plan.local.state))
            return { state: 'failed', message: plan.local.message || connectFailedLabel };
    }
    if (context.reindexError && !context.pending) return { state: 'failed', message: context.reindexError };
    return { state: 'running' };
}

/** Контекст результата «Модель готова»: куда подключена модель — сервер или конкретная установка. */
export function connectionTargetLabel(mode: 'server' | 'computer', deviceName?: string): string {
    return mode === 'server'
        ? 'Серверная база знаний проекта'
        : `установка OpenCodeRAG на компьютере «${deviceName || 'выбранном компьютере'}»`;
}
