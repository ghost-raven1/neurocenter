import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {clearRoleDraft, readRoleDraft, saveRoleDraft} from '../src/features/SystemRoleChat/roleDraft';
import {legacyRoleIntentScope, saveServiceIntent, serviceIntentScope} from '../src/features/SystemRoleChat/intent';
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn()}}));
import api from '../src/core/api/base';
import {roleConversationApi} from '../src/features/SystemRoleChat/api';

let storage: Map<string,string>;
const scope = (id = 'alice', activeRole = 'Админ проекта') => JSON.stringify({id,email:id+'@test',activeRole});
beforeEach(() => {
    vi.clearAllMocks(); storage = new Map();
    vi.stubGlobal('sessionStorage', {get length() {return storage.size;},key: (index: number) => [...storage.keys()][index] ?? null,
        getItem: (key: string) => storage.get(key) ?? null,setItem: (key: string, value: string) => storage.set(key,value),removeItem: (key: string) => storage.delete(key)});
    vi.mocked(api.get).mockResolvedValue({data: []}); vi.mocked(api.post).mockResolvedValue({data: {id:'dialog'}});
});
afterEach(() => vi.unstubAllGlobals());
it('role navigation separates editable drafts across role, person and project and survives role demotion', () => {
    saveRoleDraft(scope(), 'project-one', 'agent-coordinator', 'Coordinator draft');
    saveRoleDraft(scope(), 'project-one', 'agent-indexer', 'Indexer draft');
    expect(readRoleDraft(scope(), 'project-one', 'agent-coordinator')).toBe('Coordinator draft');
    expect(readRoleDraft(scope('alice','Наблюдатель'), 'project-one', 'agent-indexer')).toBe('Indexer draft');
    expect(readRoleDraft(scope('bob'), 'project-one', 'agent-indexer')).toBe('');
    expect(readRoleDraft(scope(), 'project-two', 'agent-indexer')).toBe('');
    clearRoleDraft(scope(), 'project-one', 'agent-coordinator');
    expect(readRoleDraft(scope(), 'project-one', 'agent-coordinator')).toBe('');
    expect(readRoleDraft(scope(), 'project-one', 'agent-indexer')).toBe('Indexer draft');
});
it('a role thread locates the original origin receipt without moving or changing its request key', () => {
    const originalScope = serviceIntentScope(scope(), 'project', 'old-project-chat-origin');
    saveServiceIntent(originalScope, {dialogId:'old-dialog',agentId:'agent-indexer',input:{projectId:'project',instruction:'Original task',requestId:'original-request',modelId:'model-one',expectedModelPin:'a'.repeat(64),expectedDefinitionPin:'b'.repeat(64),consentDigest:'c'.repeat(64),diagnostics:[],targets:[]}});
    const before = [...storage];
    expect(legacyRoleIntentScope(scope(), 'project', 'agent-indexer')).toBe(originalScope);
    expect(legacyRoleIntentScope(scope(), 'project', 'agent-coordinator')).toBeUndefined();
    expect(legacyRoleIntentScope(scope('bob'), 'project', 'agent-indexer')).toBeUndefined();
    expect([...storage]).toEqual(before);
});
it('role history is projected by the server while recovery retains the original endpoint', async () => {
    const chats = roleConversationApi('agent-indexer');
    await chats.list('project'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats',{params:{projectId:'project',agentId:'agent-indexer'}});
    await chats.read('legacy-dialog'); expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/legacy-dialog',{params:{agentId:'agent-indexer'}});
    await chats.create({id:'new-dialog',title:'Indexer',projectId:'project',agentId:'agent-indexer'});
    expect(api.post).toHaveBeenLastCalledWith('/api/system-role-chats',{id:'new-dialog',title:'Indexer',projectId:'project',agentId:'agent-indexer'});
    await chats.request('legacy-dialog','original-request');
    expect(api.get).toHaveBeenLastCalledWith('/api/system-role-chats/legacy-dialog/requests/original-request');
});
