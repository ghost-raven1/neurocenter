import {beforeEach, expect, it, vi} from 'vitest';
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn()}}));
import api from '../src/core/api/base';
import {systemRoleChatsApi as chats} from '../src/features/SystemRoleChat/api';

beforeEach(() => {vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue({data: 'read'}); vi.mocked(api.post).mockResolvedValue({data: 'write'});});
it('history and exact-request recovery use read-only project-scoped endpoints', async () => {
    expect(await chats.list('project-one')).toBe('read'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats', {params: {projectId: 'project-one'}});
    await chats.read('dialog/one'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone');
    await chats.request('dialog/one', 'request/one'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone/requests/request%2Fone'); expect(api.post).not.toHaveBeenCalled();
});
it('background history and exact-request reads forward cancellation without starting a model run', async () => {
    const signal = new AbortController().signal;
    await chats.read('dialog/one', signal); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone', {signal});
    await chats.request('dialog/one', 'request/one', signal); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/dialog%2Fone/requests/request%2Fone', {signal});
    expect(api.post).not.toHaveBeenCalled();
});
