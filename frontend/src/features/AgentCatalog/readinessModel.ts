import type { IAgentReadiness, IAgentReadinessItem, IAgentTrial } from './readinessTypes';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));
const requiredChecks = (tool: string): string[] => ['prompt_sent', 'model_response', ...(tool === 'project_search' ? ['project_search'] : [])];
const exactChecks = (checks: IAgentTrial['receipt']['checks'], tool: string): boolean => {
    const required = requiredChecks(tool);
    return checks.length === required.length && required.every(kind => checks.filter(check => check.kind === kind).length === 1);
};
export const agentTrialPending = (trial?: IAgentTrial | null): boolean => !!trial && ['queued', 'running'].includes(trial.status);

/** Incomplete or foreign execution receipts can never become a green readiness label. */
export function requireAgentTrial(value: unknown): IAgentTrial {
    const receipt = object(value) && object(value.receipt) ? value.receipt : null;
    if (!object(value) || !text(value.id) || !text(value.requestId) || !revision(value.revision) || value.executionSurface !== 'server_chat'
        || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value.status))
        || typeof value.message !== 'string' || typeof value.current !== 'boolean' || typeof value.canCancel !== 'boolean'
        || !timestamp(value.createdAt) || !receipt
        || !revision(receipt.agentVersion) || receipt.agentVersion === 0 || !digest(receipt.agentManifest) || !digest(receipt.agentPin)
        || !digest(receipt.promptSha256) || !digest(receipt.configSha256) || !text(receipt.modelId) || !text(receipt.modelName)
        || !digest(receipt.modelPin) || !['none', 'project_search'].includes(String(receipt.toolMode)) || !Array.isArray(receipt.checks)
        || !receipt.checks.every(check => object(check) && ['prompt_sent', 'model_response', 'project_search'].includes(String(check.kind))
            && ['passed', 'failed', 'not_run'].includes(String(check.status)) && typeof check.message === 'string')) {
        throw new Error('Сервер вернул неполное подтверждение испытания. Перечитайте состояние.');
    }
    const trial = value as unknown as IAgentTrial, pending = agentTrialPending(trial);
    if (!exactChecks(trial.receipt.checks, trial.receipt.toolMode) || pending && trial.finishedAt !== null
        || !pending && (!timestamp(trial.finishedAt) || trial.canCancel)
        || trial.status === 'succeeded' && trial.receipt.checks.some(check => check.status !== 'passed')) {
        throw new Error('Сервер вернул неполное подтверждение испытания. Перечитайте состояние.');
    }
    return trial;
}

export function requireAgentReadiness(value: unknown): IAgentReadiness {
    const invalid = (): never => { throw new Error('Состояние испытаний не подтверждено. Повторите загрузку.'); };
    if (!object(value) || value.executionSurface !== 'server_chat' || !Array.isArray(value.items)) return invalid();
    const ids = new Set<string>();
    for (const item of value.items) {
        if (!object(item) || !text(item.agentId) || ids.has(item.agentId) || !digest(item.currentPin) || !revision(item.projectRevision)
            || !object(item.eligibility)) return invalid();
        ids.add(item.agentId);
        const allowed = item.eligibility;
        if (typeof allowed.canRun !== 'boolean' || !['fixed', 'choose'].includes(String(allowed.modelSelection)) || !Array.isArray(allowed.models)
            || !allowed.models.every(model => object(model) && text(model.id) && text(model.name) && digest(model.pin) && typeof model.available === 'boolean')
            || !Array.isArray(allowed.tools) || !allowed.tools.every(tool => object(tool) && tool.kind === 'project_search'
                && typeof tool.available === 'boolean' && typeof tool.requiresConsent === 'boolean')) return invalid();
        if (item.latestTrial !== null) requireAgentTrial(item.latestTrial);
    }
    return value as unknown as IAgentReadiness;
}

/** A late receipt may be displayed historically, but only matching current pins may remain current. */
export function reconcileAgentTrial(item: IAgentReadinessItem, trial: IAgentTrial): IAgentTrial {
    const model = item.eligibility.models.find(value => value.id === trial.receipt.modelId);
    return trial.current && (trial.receipt.agentPin !== item.currentPin || model?.pin !== trial.receipt.modelPin)
        ? { ...trial, current: false, staleReason: 'Промпт, параметры или модель изменились после запуска.' } : trial;
}

export function agentTrialStatus(trial?: IAgentTrial | null): { label: string; color?: string } {
    if (!trial) return { label: 'В чате ещё не испытывался' };
    if (agentTrialPending(trial)) return { label: 'Идёт испытание в чате', color: 'blue' };
    if (!trial.current) return { label: 'Предыдущая проверка устарела', color: 'orange' };
    if (trial.status === 'succeeded' && timestamp(trial.finishedAt) && !trial.canCancel && exactChecks(trial.receipt.checks, trial.receipt.toolMode)
        && trial.receipt.checks.every(check => check.status === 'passed'))
        return { label: 'Проверено в чате Нейроцентра', color: 'green' };
    return { label: trial.status === 'cancelled' ? 'Испытание остановлено' : trial.status === 'interrupted' ? 'Испытание прервано' : 'Испытание не пройдено', color: trial.status === 'cancelled' ? undefined : 'red' };
}
