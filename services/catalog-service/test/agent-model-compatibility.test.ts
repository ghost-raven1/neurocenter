import { describe, expect, it, vi } from 'vitest';
import type { ProjectAgent } from '../../shared/project-agents.cjs';
import { createProjectAgentsPayload } from '../../shared/project-agents.cjs';
import { agentModelRequirements } from '../src/agents/agent-model-requirements';
import type { IModelRow } from '../src/models/model-history';

const agent: ProjectAgent = { id: 'agent-fixture', slug: 'nc-review', version: 1, enabled: true,
    description: 'Fixture', prompt: 'Review', mode: 'subagent', permission: { read: 'allow', edit: 'ask' }, model: 'neurocenter/model-fixture' };
const row: IModelRow = { id: 'model-fixture', name: 'Fixture', revision: 1, created_at: '', updated_at: '',
    descriptor: { description: '', runtime: 'remote-openai', capability: 'chat', model: 'requested-alias', modelVersion: 'v1',
        dimension: null, manifestSha256: null, verificationSha256: 'a'.repeat(64), source: 'custom' } };

/** SQL doubles isolate the native-agent contract; these are not PostgreSQL acceptance tests. */
function fixture(options: Record<string, unknown>) {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ base_url: 'https://models.example.test/v1', options }] });
    return { query, db: { query } as unknown as Parameters<typeof agentModelRequirements>[0] };
}

describe('OpenAI compatibility остаётся на сервере при настройке native агентов', () => {
    it('Передаёт только числовые generation options в проверяемый native contract', async () => {
        const { db, query } = fixture({ temperature: 0, topP: 0.9, maxOutputTokens: 4096, contextWindow: 128000,
            responseModel: 'snapshot-v1', tokenLimitParameter: 'max_tokens' });
        const requirements = await agentModelRequirements(db, 'prj-fixture', [agent]);
        expect(requirements).toMatchObject([{ kind: 'catalog', runtimeModel: 'requested-alias', options: { temperature: 0, topP: 0.9, maxOutputTokens: 4096, contextWindow: 128000 } }]);
        const requirement = requirements[0];
        if (requirement.kind !== 'catalog') throw Error('Expected a catalog requirement');
        expect(Object.values(requirement.options).every(value => typeof value === 'number')).toBe(true);
        expect(requirement.options).not.toHaveProperty('responseModel');
        expect(requirement.options).not.toHaveProperty('tokenLimitParameter');
        expect(() => createProjectAgentsPayload({ schemaVersion: 2, projectId: 'prj-fixture', bindingId: 'b'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111', revision: 1,
            agents: [agent], modelRequirements: requirements })).not.toThrow();
        expect(query).toHaveBeenCalledTimes(2);
    });
    it('Не превращает настройки совместимости в фиктивные параметры генерации', async () => {
        const { db } = fixture({ responseModel: 'snapshot-v1', tokenLimitParameter: 'max_tokens' });
        const [requirement] = await agentModelRequirements(db, 'prj-fixture', [agent]);
        if (requirement.kind !== 'catalog') throw Error('Expected a catalog requirement');
        expect(requirement.options).toEqual({});
    });
    it('Продолжает отвергать повреждённые числовые настройки до выдачи задания', async () => {
        const { db } = fixture({ responseModel: 'snapshot-v1', temperature: '0' });
        await expect(agentModelRequirements(db, 'prj-fixture', [agent])).rejects.toMatchObject({ status: 400 });
    });
    it('Требует явную локальную настройку несовместимого max_completion_tokens до выдачи задания', async () => {
        const {db} = fixture({temperature: 0, tokenLimitParameter: 'max_completion_tokens'});
        await expect(agentModelRequirements(db, 'prj-fixture', [agent])).rejects.toMatchObject({status: 409,
            response: {code: 'OPENCODE_AGENT_MODEL_SETUP_REQUIRED', action: 'sync-opencode-models'}});
    });
});
