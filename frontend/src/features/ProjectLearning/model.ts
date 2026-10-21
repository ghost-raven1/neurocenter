import type {LearningAnalysis, LearningCandidate, LearningCommand, LearningOverview, LearningMutationResult} from './types';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const records = (value: unknown): value is Array<Record<string, unknown>> => Array.isArray(value) && value.every(object);

/** A stale or malformed response cannot become another project's review surface. */
export function requireLearningOverview(value: unknown, projectId: string): LearningOverview {
    const capabilities = object(value) && object(value.capabilities) ? value.capabilities : null;
    if (!object(value) || value.schemaVersion !== 1 || value.projectId !== projectId || !revision(value.revision)
        || !capabilities || !['read', 'record', 'review', 'approve'].every(key => typeof capabilities[key] === 'boolean')
        || !records(value.experiences) || !value.experiences.every(item => text(item.id) && item.projectId === projectId && text(item.title) && text(item.summary) && object(item.context) && Array.isArray(item.evidence) && item.evidence.every(object))
        || !records(value.hypotheses) || !value.hypotheses.every(item => text(item.id) && item.projectId === projectId && text(item.title) && text(item.statement) && Array.isArray(item.experienceIds) && item.experienceIds.every(text) && records(item.checks) && item.checks.every(check => check.projectId === projectId && check.hypothesisId === item.id && Array.isArray(check.experienceIds)))
        || !records(value.candidates) || !value.candidates.every(item => text(item.id) && item.projectId === projectId && text(item.title) && text(item.content) && typeof item.active === 'boolean' && ['proposed', 'approved', 'rejected', 'revoked'].includes(String(item.status)))
        || !records(value.activeCandidates) || !value.activeCandidates.every(item => item.projectId === projectId && text(item.id) && text(item.title) && text(item.content) && text(item.key) && item.status === 'approved' && item.active === true)
        || !object(value.pages) || !['experiences', 'hypotheses', 'candidates'].every(key => {
            const page = (value.pages as Record<string, unknown>)[key]; return object(page) && revision(page.total) && (page.nextCursor === null || text(page.nextCursor));
        })
        || !records(value.history) || !value.history.every(item => item.projectId === projectId && object(item.details))) throw new Error('Сервер вернул некорректное состояние обучения проекта. Обновите данные.');
    return value as unknown as LearningOverview;
}

export function requireLearningReceipt(value: unknown, projectId: string, requestKey: string): LearningMutationResult {
    if (!object(value) || value.schemaVersion !== 1 || value.projectId !== projectId || value.requestKey !== requestKey || !revision(value.revision) || !object(value.result))
        throw new Error('Сохранение не подтверждено точной квитанцией проекта. Проверьте результат запроса.');
    return value as unknown as LearningMutationResult;
}

export function requireLearningAnalysis(value: unknown, projectId: string, requestKey?: string): LearningAnalysis {
    if (!object(value) || value.projectId !== projectId || !text(value.id) || !text(value.requestKey) || requestKey !== undefined && value.requestKey !== requestKey
        || !['queued', 'running', 'completed', 'failed', 'unknown'].includes(String(value.state)) || !Array.isArray(value.hypothesisIds))
        throw new Error('Анализ не подтверждён сервером для выбранного проекта.');
    return value as unknown as LearningAnalysis;
}

export const hypothesisStatus = {open: 'Не проверена', supported: 'Поддержана проверкой', refuted: 'Опровергнута', inconclusive: 'Недостаточно данных'};
export const candidateStatus = {proposed: 'На одобрении', approved: 'Одобрено', rejected: 'Отклонено', revoked: 'Отозвано'};
export const outcomeLabel = {succeeded: 'Успех', failed: 'Ошибка', mixed: 'Частичный результат', unknown: 'Неизвестно'};
export const checkResultLabel = {passed: 'Подтверждает', failed: 'Опровергает', inconclusive: 'Недостаточно данных'};
export const evidenceKindLabel = {test: 'Тест', typecheck: 'Проверка типов', lint: 'Линтер', lsp: 'LSP', human_feedback: 'Отзыв человека', artifact: 'Артефакт', observation: 'Наблюдение'};
export const analysisStateLabel = {queued: 'Анализ в очереди', running: 'Строим гипотезы', completed: 'Гипотезы построены', failed: 'Анализ завершился ошибкой', unknown: 'Результат анализа неизвестен'};
export const isAnalysisPending = (analysis: LearningAnalysis | null): boolean => !!analysis && ['queued', 'running'].includes(analysis.state);
export const activeLearning = (candidate: LearningCandidate): boolean => candidate.status === 'approved' && candidate.active;
export const learningCandidates = (data: LearningOverview): LearningCandidate[] => [...new Map([...data.candidates, ...data.activeCandidates].map(item => [item.id, item])).values()];
export const commandCapability = (command: LearningCommand): 'record' | 'review' | 'approve' => command.kind === 'experience' || command.kind === 'hypothesis' || command.kind === 'candidate' ? 'record' : command.kind === 'check' ? 'review' : 'approve';
