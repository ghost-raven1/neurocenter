import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
import api from '../src/core/api/base';
import { systemRoleChatsApi as chats } from '../src/features/SystemRoleChat/api';
import type { RoleRun, RoleStart } from '../src/features/SystemRoles/types';
import type { ServiceTurn } from '../src/features/SystemRoleChat/types';

beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue({ data: 'read' }); vi.mocked(api.post).mockResolvedValue({ data: 'write' }); });
it('history and exact-request recovery use read-only project-scoped endpoints', async () => {
    expect(await chats.list('project-one')).toBe('read'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats', { params: { projectId: 'project-one' } });
    await chats.read('dialog/one'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone');
    await chats.request('dialog/one', 'request/one'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone/requests/request%2Fone'); expect(api.post).not.toHaveBeenCalled();
});
it('background history and exact-request reads forward cancellation without starting a model run', async () => {
    const signal = new AbortController().signal;
    await chats.read('dialog/one', signal); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone', {signal});
    await chats.request('dialog/one', 'request/one', signal); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone/requests/request%2Fone', {signal});
    expect(api.post).not.toHaveBeenCalled();
});
it('preparation forwards explicit own-context consent and inference uses the supplied immutable request', async () => {
    const selection = { projectId: 'project-one', instruction: 'Check', diagnostics: [], targets: [] };
    await chats.prepare('dialog-one', 'agent-coordinator', selection, false); expect(api.post).toHaveBeenLastCalledWith('/api/system-role-chats/dialog-one/prepare', { agentId: 'agent-coordinator', selection, includeContext: false });
    const input = { ...selection, requestId: 'immutable-one', modelId: 'model-one', expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: 'b'.repeat(64), consentDigest: 'c'.repeat(64) } satisfies RoleStart;
    await chats.start('dialog-one', 'agent-coordinator', input); expect(api.post).toHaveBeenLastCalledWith('/api/system-role-chats/dialog-one/turns', { agentId: 'agent-coordinator', input });
});
it('cancellation checks the selected run revision at the chat owner endpoint', async () => {
    const turn = { id: 'turn-one', run: { revision: 7 } } as ServiceTurn; await chats.cancel('dialog-one', turn, 'cancel-key');
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/system-role-chats/dialog-one/turns/turn-one/cancel', { requestId: 'cancel-key', expectedRevision: 7 });
});
it.each([11, 8])('saved run history displays the authoritative model-call budget %i', async modelCallBudget => {
    const { createElement } = await import('react'), { renderToStaticMarkup } = await import('react-dom/server'), { RoleRunContent } = await import('../src/features/SystemRoles/RoleRunContent');
    const run = { id: 'run-one', agentId: modelCallBudget === 11 ? 'agent-coordinator' : 'agent-ai-admin', state: 'running', phase: 'model_step', revision: 1, operationId: 'operation-one', message: 'Collecting',
        callsStarted: 6, modelCallBudget, modelId: 'model-one', modelPin: 'a'.repeat(64), facts: [], result: null, steps: [], applied: [], targets: [] } as unknown as RoleRun;
    const html = renderToStaticMarkup(createElement(RoleRunContent, { run })); expect(html).toContain('6 / ' + modelCallBudget);
});
