import type { IAgentReadiness, IAgentReadinessItem, IAgentTrial } from '../src/features/AgentCatalog/readinessTypes';

export const trial = (changes: Partial<IAgentTrial> = {}): IAgentTrial => ({
    id: 'trial-one', requestId: '11111111-1111-4111-8111-111111111111', revision: 1, executionSurface: 'server_chat', status: 'succeeded',
    message: 'Контрольное задание выполнено.', createdAt: '2026-10-22T00:00:00Z', finishedAt: ['queued', 'running'].includes(changes.status ?? '') ? null : '2026-10-22T00:00:01Z', current: true, canCancel: false,
    receipt: { agentVersion: 1, agentManifest: 'a'.repeat(64), agentPin: 'b'.repeat(64), promptSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64),
        modelId: 'model-one', modelName: 'Модель проекта', modelPin: 'e'.repeat(64), toolMode: 'none',
        checks: [{ kind: 'prompt_sent', status: 'passed', message: 'Сохранённый промпт отправлен.' }, { kind: 'model_response', status: 'passed', message: 'Ответ проверен.' }] }, ...changes,
});
export const readinessItem = (changes: Partial<IAgentReadinessItem> = {}): IAgentReadinessItem => ({
    agentId: 'agent-review', currentPin: 'b'.repeat(64), projectRevision: 3,
    eligibility: { canRun: true, modelSelection: 'choose', models: [{ id: 'model-one', name: 'Модель проекта', pin: 'e'.repeat(64), available: true }],
        tools: [{ kind: 'project_search', available: true, requiresConsent: true }] }, latestTrial: null, ...changes,
});
export const readiness = (item = readinessItem()): IAgentReadiness => ({ executionSurface: 'server_chat', items: [item] });
