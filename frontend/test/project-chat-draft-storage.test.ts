import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {projectMessage} from './project-chat-fixtures';
import {projectChatDraftScope, readProjectChatDraft, saveProjectChatDraft} from '../src/features/ProjectChat/draftStorage';
import type {ProjectChatDraft} from '../src/features/ProjectChat/types';

let storage: Map<string, string>, sequence = 0;
const key = () => 'draft-storage-' + (++sequence);
const draft = (): ProjectChatDraft => ({body: 'Вопрос команде', delivery: 'selected', agentIds: ['reviewer'], reply: projectMessage(),
    pending: {requestKey: 'original-request', prompt: 'Вопрос команде', replyToId: 'human-one', targetAgentIds: ['reviewer'],
        agentTools: {protocol: 'json-actions-v1', rag: true, systemRoles: true, publicChats: {modelId: 'model-one', expectedModelPin: 'a'.repeat(64), consent: true, roomId: 'room-one'}}}});
beforeEach(() => {
    storage = new Map(); vi.stubGlobal('sessionStorage', {getItem: (name: string) => storage.get(name) ?? null,
        setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name)});
});
afterEach(() => vi.unstubAllGlobals());

describe('team chat reload storage', () => {
    it('restores the exact consented tools, reply preview and recipient order from browser data', async () => {
        const scope = key(), original = draft(); expect(saveProjectChatDraft(scope, original)).toBe(true);
        vi.resetModules(); const fresh = await import('../src/features/ProjectChat/draftStorage');
        expect(fresh.readProjectChatDraft(scope)).toEqual(original); expect(fresh.readProjectChatDraft(key())).toEqual({body: '', delivery: 'people', agentIds: []});
    });
    it('separates people, projects and rooms while retaining recovery after role/policy changes', () => {
        const scope = (id = 'alice', project = 'project-one', room = 'room-one', role = 'admin', email = 'alice@example.test') =>
            projectChatDraftScope(JSON.stringify([JSON.stringify({id, email, activeRole: role}), project, room]));
        saveProjectChatDraft(scope(), draft());
        expect(readProjectChatDraft(scope('alice', 'project-one', 'room-one', 'observer'))).toEqual(draft());
        for (const other of [scope('bob'), scope('alice', 'project-two'), scope('alice', 'project-one', 'room-two'), scope('alice', 'project-one', 'room-one', 'admin', 'bob@example.test')]) {
            expect(readProjectChatDraft(other).pending).toBeUndefined(); expect(readProjectChatDraft(other).body).toBe('');
        }
    });
    it.each(['broken-json', 'oversized', 'invalid-body', 'invalid-reply', 'invalid-pending', 'different-prompt', 'different-reply', 'invalid-grant', 'extra-intent-field'])('ignores %s without sending a new request', kind => {
        const scope = key(), value = draft() as unknown as Record<string, unknown>;
        if (kind === 'invalid-body') value.body = {};
        if (kind === 'invalid-reply') value.reply = {id: 'human-one'};
        if (kind === 'invalid-pending') value.pending = {requestKey: 'original-request'};
        if (kind === 'different-prompt') (value.pending as Record<string, unknown>).prompt = 'Changed consent';
        if (kind === 'different-reply') (value.pending as Record<string, unknown>).replyToId = 'other-message';
        if (kind === 'invalid-grant') (value.pending as Record<string, unknown>).agentTools = {protocol: 'json-actions-v1', rag: true, publicChats: {consent: false}};
        if (kind === 'extra-intent-field') (value.pending as Record<string, unknown>).autoExecute = true;
        const raw = kind === 'broken-json' ? '{' : kind === 'oversized' ? ' '.repeat(1024 * 1024 + 1) : JSON.stringify({version: 1, draft: value});
        storage.set('neurocenter:project-chat-draft:v1:' + scope, raw);
        expect(readProjectChatDraft(scope)).toEqual({body: '', delivery: 'people', agentIds: []});
    });
    it('clears acknowledged work from browser storage and from memory', async () => {
        const scope = key(); saveProjectChatDraft(scope, draft()); saveProjectChatDraft(scope, {body: '', delivery: 'people', agentIds: []});
        expect(storage.size).toBe(0); expect(readProjectChatDraft(scope).pending).toBeUndefined();
        vi.resetModules(); expect((await import('../src/features/ProjectChat/draftStorage')).readProjectChatDraft(scope).pending).toBeUndefined();
    });
    it('retains an editable in-memory draft if browser writes are denied and handles denied reads', () => {
        const scope = key(); vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {throw Error('QuotaExceeded');});
        const original = {...draft(), pending: undefined}; expect(saveProjectChatDraft(scope, original)).toBe(false); expect(readProjectChatDraft(scope)).toEqual(original);
        vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => {throw Error('SecurityError');}); expect(readProjectChatDraft(key()).pending).toBeUndefined();
    });
});
