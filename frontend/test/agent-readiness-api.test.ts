import { beforeEach, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { agentReadinessApi } from '../src/features/AgentCatalog/readinessApi';
import { readiness, trial } from './agent-readiness.fixture';
vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue({ data: readiness() }); vi.mocked(api.post).mockResolvedValue({ data: trial() }); });
it('reads one batch through Gateway without starting inference; individual receipts preserve scoped encoded IDs', async () => {
    const signal = new AbortController().signal; await agentReadinessApi.list('project/a', signal);
    expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/projects/project%2Fa/agents/readiness', { signal }); expect(api.post).not.toHaveBeenCalled();
    vi.mocked(api.get).mockResolvedValueOnce({ data: trial() }); await agentReadinessApi.read('project/a', 'agent/a', 'trial/a', signal);
    expect(api.get).toHaveBeenLastCalledWith('/api/projects/project%2Fa/agents/agent%2Fa/readiness-trials/trial%2Fa', { signal });
});
it('sends immutable pins/CAS/consent and the same request ID without a browser-supplied prompt', async () => {
    const signal = new AbortController().signal, input = { requestId: trial().requestId, expectedRevision: 3, expectedAgentPin: 'b'.repeat(64), modelId: 'model-one', expectedModelPin: 'e'.repeat(64), tool: 'project_search' as const, toolConsent: true };
    await agentReadinessApi.start('p', 'agent/a', input, signal);
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/projects/p/agents/agent%2Fa/readiness-trials', input, { signal });
    expect(vi.mocked(api.post).mock.calls[0][1]).not.toHaveProperty('prompt');
    await agentReadinessApi.cancel('p', 'agent/a', trial({ revision: 7 }), signal);
    expect(api.post).toHaveBeenLastCalledWith('/api/projects/p/agents/agent%2Fa/readiness-trials/trial-one/cancel', { expectedRevision: 7 }, { signal });
});
