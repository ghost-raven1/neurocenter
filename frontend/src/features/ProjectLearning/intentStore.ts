import type {LearningIntent} from './types';

const prefix = 'neurocenter.learning.intent.';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const commandKinds = ['experience', 'hypothesis', 'check', 'candidate', 'approve', 'reject', 'revoke', 'activate'];
export const learningIntentScope = (scope: string, projectId: string): string => prefix + JSON.stringify([scope, projectId]);

/** Recovery data is scoped to this browser session, identity and project; it cannot choose another API route. */
export function validLearningIntent(value: unknown, projectId: string): value is LearningIntent {
    if (!object(value) || value.projectId !== projectId || !uuid(value.requestKey) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0
        || !object(value.command) || !commandKinds.includes(String(value.command.kind)) || !object(value.command.value)) return false;
    if (value.command.kind === 'check') return uuid(value.command.hypothesisId);
    if (['approve', 'reject', 'revoke', 'activate'].includes(String(value.command.kind))) return uuid(value.command.candidateId);
    return true;
}

const unavailable = (): Error => new Error('Не удалось сохранить квитанцию запроса в браузере. Запись не отправлена. Разрешите хранение данных сайта и повторите.');
export function readLearningIntent(key: string, projectId: string, storage: Storage = sessionStorage): LearningIntent | null {
    let raw: string | null;
    try { raw = storage.getItem(key); } catch { throw unavailable(); }
    if (!raw) return null;
    let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('Сохранённый запрос обучения повреждён. Обратитесь к администратору.'); }
    if (!validLearningIntent(value, projectId)) throw new Error('Сохранённый запрос не соответствует этому проекту.');
    return value;
}
export function saveLearningIntent(key: string, intent: LearningIntent, storage: Storage = sessionStorage): void {
    const previous = readLearningIntent(key, intent.projectId, storage);
    if (previous && JSON.stringify(previous) !== JSON.stringify(intent)) throw new Error('Предыдущий запрос ещё не подтверждён. Сначала проверьте его результат.');
    try { storage.setItem(key, JSON.stringify(intent)); } catch { throw unavailable(); }
}
export function clearLearningIntent(key: string, requestKey: string, projectId: string, storage: Storage = sessionStorage): void {
    const previous = readLearningIntent(key, projectId, storage);
    if (previous && previous.requestKey !== requestKey) throw new Error('Квитанция запроса изменилась. Обновите состояние.');
    try { storage.removeItem(key); } catch { throw unavailable(); }
}
