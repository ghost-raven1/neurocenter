import type { ServiceIntent, ServiceReceipt } from './types';

const inputs = new Map<string, ServiceIntent>();
const storageKey = (scope: string): string => 'neurocenter:service-chat-request:' + scope;
const maxBytes = 131072, bytes = (value: string): number => new TextEncoder().encode(value).length;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const pin = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Pending work belongs to a person and project; changing current rights only fences live callbacks. */
export function serviceIntentScope(authScope: string, projectId: string | undefined, origin?: string): string {
    let principal = authScope;
    try {
        const value: unknown = JSON.parse(authScope);
        if (object(value) && identifier(value.id) && identifier(value.email)) principal = JSON.stringify([value.id, value.email]);
    } catch { /* Unknown scope formats retain their own isolation. */ }
    return JSON.stringify([principal, projectId ?? null, ...(origin ? [origin] : [])]);
}
/** Restore only the original bounded request for this principal/project; the server revalidates every pin. */
function validIntent(value: unknown, scope: string): value is ServiceIntent {
    if (!object(value) || !identifier(value.dialogId) || !['agent-ai-admin', 'agent-autoconfigurator', 'agent-indexer', 'agent-packager', 'agent-coordinator'].includes(String(value.agentId)) || !object(value.input)) return false;
    const input = value.input;
    let project: unknown; try { project = JSON.parse(scope)[1]; } catch { return false; }
    return input.projectId === project && identifier(input.requestId) && identifier(input.modelId) && typeof input.instruction === 'string' && bytes(input.instruction) <= 2048
        && pin(input.expectedModelPin) && pin(input.expectedDefinitionPin) && pin(input.consentDigest)
        && Array.isArray(input.diagnostics) && input.diagnostics.length <= 5 && input.diagnostics.every(item => ['health', 'project', 'bridge', 'containers', 'index'].includes(String(item)))
        && Array.isArray(input.targets) && input.targets.length <= 4 && input.targets.every(item => object(item) && identifier(item.id) && ['prompt', 'agent', 'skill', 'plugin-settings', 'adapter', 'public-chat', 'package-source', 'dialog-context'].includes(String(item.kind)))
        && Object.keys(input).every(key => ['projectId', 'instruction', 'diagnostics', 'targets', 'requestId', 'modelId', 'expectedModelPin', 'expectedDefinitionPin', 'consentDigest', 'mcp'].includes(key));
}
/** Session recovery retains the exact consented input, without model credentials or measured system snapshots. */
export function saveServiceIntent(scope: string, intent: ServiceIntent): void {
    const value = JSON.stringify({ version: 1, intent });
    if (bytes(value) > maxBytes || !validIntent(intent, scope)) throw new Error('Уменьшите задачу и выбранный контекст перед отправкой.');
    try { sessionStorage.setItem(storageKey(scope), value); }
    catch { throw new Error('Не удалось сохранить запрос в браузере. Отправка не начата. Разрешите хранение данных сайта и повторите.'); }
    inputs.set(scope, structuredClone(intent));
}
export function serviceIntent(scope: string): ServiceIntent | undefined {
    const memory = inputs.get(scope); if (memory) return memory;
    try {
        const raw = sessionStorage.getItem(storageKey(scope)); if (!raw || bytes(raw) > maxBytes) return undefined;
        const value: unknown = JSON.parse(raw);
        if (object(value) && value.version === 1 && validIntent(value.intent, scope)) { inputs.set(scope, value.intent); return value.intent; }
    } catch { /* Broken or inaccessible session data cannot restore a different scope. */ }
    return undefined;
}
export function serviceReceipt(scope: string): ServiceReceipt | undefined {
    const input = serviceIntent(scope);
    if (input) return { dialogId: input.dialogId, requestId: input.input.requestId };
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(scope)) || 'null');
        if (object(value) && value.version === 1 && object(value.intent) && object(value.intent.input)) {
            const saved = value.intent, input = value.intent.input;
            if (input.projectId === JSON.parse(scope)[1] && identifier(saved.dialogId) && identifier(input.requestId)) return { dialogId: saved.dialogId, requestId: input.requestId };
        }
        if (object(value) && identifier(value.dialogId) && identifier(value.requestId)) return { dialogId: value.dialogId, requestId: value.requestId };
    } catch { /* A broken receipt cannot restore a different user's request. */ }
    return undefined;
}
export function clearServiceIntent(scope: string): void {
    inputs.delete(scope);
    try { sessionStorage.removeItem(storageKey(scope)); } catch { /* Storage is optional. */ }
}
