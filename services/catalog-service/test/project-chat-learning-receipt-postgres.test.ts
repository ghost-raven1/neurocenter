import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { LearningRepository } from '../src/learning/learning.repository';
import type { ChatLearningReceipt } from '../src/model-chat/chat-learning-context.types';
import type { ChatMessage } from '../src/model-chat/chat.types';
import { adminUrl, bounded, deferred, developer, projectChatLearningFixture, projectId, reply } from './project-chat-learning-receipt.fixture';

describe.skipIf(!adminUrl).sequential('Team chat learning receipts — actual PostgreSQL and runtime admission', () => {
    let f: Awaited<ReturnType<typeof projectChatLearningFixture>>;
    beforeAll(async () => { f = await projectChatLearningFixture(); });
    beforeEach(async () => { await f.setup(); });
    afterEach(async () => { await f.cleanup(); });
    afterAll(async () => { await f?.close(); });
    const ref = (entry: { id: string; key: string; version: number; content: string }) => ({ id: entry.id, key: entry.key, version: entry.version,
        sha256: createHash('sha256').update(entry.content).digest('hex') });
    const settle = async () => { await bounded(f.service.runner.waitIdle()); return f.read(); };
    const row = async (id: string) => (await f.pool.query('SELECT * FROM project_chat_messages WHERE id=$1', [id])).rows[0];

    it('returns and atomically persists recipient-scoped references matching the actual outbound learning data', async () => {
        const a = await f.agent('A'), b = await f.agent('B');
        const common = await f.knowledge('common', 'COMMON APPROVED KNOWLEDGE'), own = await f.knowledge('own', 'A ONLY APPROVED KNOWLEDGE', a.id);
        const other = await f.knowledge('other', 'B ONLY APPROVED KNOWLEDGE', b.id);
        await f.knowledge('pending', 'UNAPPROVED KNOWLEDGE', a.id, { approve: false });
        await f.knowledge('foreign', 'FOREIGN PROJECT KNOWLEDGE', undefined, { projectId: 'prj-other' });
        await f.configure([a.id, b.id]); const accepted = await f.send(), detail = await settle();
        const responses = detail.messages.filter(message => message.sourceMessageId === accepted.message.id && message.kind === 'agent');
        expect(responses.map(message => message.status)).toEqual(['done', 'done']);
        expect(f.calls).toHaveLength(2);
        const payload = JSON.stringify(f.calls.find(call => call.agentId === a.id)!.messages);
        expect(payload).toContain(common.content); expect(payload).toContain(own.content);
        for (const excluded of [other.content, 'UNAPPROVED KNOWLEDGE', 'FOREIGN PROJECT KNOWLEDGE']) expect(payload).not.toContain(excluded);
        expect(f.calls[0].messages.filter(message => message.role === 'system').some(message => message.content.includes(own.content))).toBe(false);
        const second = JSON.stringify(f.calls.find(call => call.agentId === b.id)!.messages);
        expect(second).toContain(other.content); expect(second).not.toContain(own.content);
        const expected = { status: 'applied', projectId, agentId: a.id, entries: [ref(common), ref(own)] };
        const digest = createHash('sha256').update(JSON.stringify({ projectId, agentId: a.id, entries: expected.entries })).digest('hex');
        const actualInfer = await vi.mocked(f.inference.infer).mock.results[0].value;
        expect.soft(actualInfer).toMatchObject({ learning: { ...expected, revision: await f.repository.revision(projectId), digest } });
        const message = responses.find(message => message.agent?.id === a.id)!;
        expect.soft(message).toMatchObject({ learning: expected });
        const stored = await row(message.id);
        expect.soft(stored.learning).toMatchObject(expected);
        expect.soft(stored.learning).toEqual((actualInfer as { learning?: ChatLearningReceipt }).learning);
        expect(stored.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, reported: false });
        expect(JSON.stringify(detail)).not.toContain(own.content);
    });

    it.each(['disabled', 'empty'] as const)('keeps an explicit %s receipt without inventing approved references', async status => {
        const a = await f.agent('A'); if (status === 'disabled') f.setEnabled(false);
        const context = vi.spyOn(LearningRepository.prototype, 'context');
        await f.configure([a.id]); const accepted = await f.send(), detail = await settle();
        const response = detail.messages.find(message => message.sourceMessageId === accepted.message.id && message.kind === 'agent')!;
        expect(response.status).toBe('done');
        expect.soft(response).toMatchObject({ learning: { status, projectId, agentId: a.id, entries: [] } });
        const stored = await row(response.id);
        expect.soft(stored.learning).toMatchObject({ status, entries: [] });
        if (status === 'disabled') { expect(context).not.toHaveBeenCalled(); expect.soft(stored.learning).not.toHaveProperty('revision'); expect.soft(stored.learning).not.toHaveProperty('digest'); }
        else expect.soft(stored.learning).toMatchObject({ revision: expect.any(Number), digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(JSON.stringify(f.calls)).not.toContain('Одобренная запись проекта');
    });

    it.each(['knowledge', 'flag', 'acl'] as const)('rechecks %s after a real usage reservation wait and blocks provider dispatch', async revoke => {
        const a = await f.agent('A'), entry = await f.knowledge('own', 'WITHDRAW BEFORE DISPATCH', a.id);
        await f.configure([a.id]);
        const reached = deferred(), release = deferred();
        f.setAdmission(async () => { reached.resolve(); await bounded(release.promise); });
        const accepted = await f.send();
        try {
            await bounded(reached.promise);
            expect((await f.pool.query('SELECT status FROM model_usage_calls')).rows).toEqual([{ status: 'pending' }]);
            if (revoke === 'knowledge') await f.revoke(entry.id);
            if (revoke === 'flag') f.setEnabled(false);
            if (revoke === 'acl') await f.pool.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2', [projectId, developer.email]);
        } finally { release.resolve(); }
        await bounded(f.service.runner.waitIdle());
        expect(f.provider.infer).not.toHaveBeenCalled();
        const responses = (await f.pool.query("SELECT * FROM project_chat_messages WHERE source_message_id=$1 AND kind='agent'", [accepted.message.id])).rows;
        expect(responses).toHaveLength(1); expect(responses[0]).toMatchObject({ status: 'failed', content: '', usage: null });
        expect(responses[0].learning ?? null).toBeNull();
        expect((await f.pool.query('SELECT status FROM model_usage_calls')).rows).toEqual([{ status: 'error' }]);
    });

    it('preserves completed output and its original immutable receipt after knowledge revoke and flag-off', async () => {
        const a = await f.agent('A'), entry = await f.knowledge('own', 'APPROVED AT PAID DISPATCH', a.id);
        await f.configure([a.id]);
        f.provider.infer.mockImplementationOnce(async (_model, _endpoint, body) => {
            f.calls.push({ agentId: a.id, messages: structuredClone(body.messages as ChatMessage[]) });
            await f.revoke(entry.id); f.setEnabled(false); return reply('Уже полученный ответ');
        });
        const accepted = await f.send(), first = await settle();
        const response = first.messages.find(message => message.sourceMessageId === accepted.message.id && message.kind === 'agent')!;
        expect(response).toMatchObject({ status: 'done', content: 'Уже полученный ответ' });
        expect.soft(response).toMatchObject({ learning: { status: 'applied', entries: [ref(entry)] } });
        const stored = await row(response.id);
        expect.soft(stored.learning).toMatchObject({ status: 'applied', entries: [ref(entry)] });
        const receipt = stored.learning;
        const next = await f.send(); await settle();
        const nextResponse = (await f.pool.query("SELECT * FROM project_chat_messages WHERE source_message_id=$1 AND kind='agent'", [next.message.id])).rows[0];
        expect.soft(nextResponse.learning).toMatchObject({ status: 'disabled', entries: [] });
        expect((await row(response.id)).learning).toEqual(receipt);
        expect(f.calls).toHaveLength(2); expect(JSON.stringify(f.calls[1])).not.toContain(entry.content);
        // A completed receipt must be fenced by the same database trigger as its paid answer.
        await expect(f.pool.query('UPDATE project_chat_messages SET learning=NULL WHERE id=$1', [response.id])).rejects.toThrow('Project chat message attribution is immutable');
        expect((await row(response.id)).learning).toEqual(receipt);
        expect((await f.pool.query('SELECT status FROM model_usage_calls ORDER BY started_at')).rows.every(item => item.status === 'success')).toBe(true);
    });
});
