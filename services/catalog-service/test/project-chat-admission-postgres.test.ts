import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminUrl, projectChatAdmissionFixture, projectId, req, type AdmissionLane } from './project-chat-admission.fixture';
import type { ProjectChatDb } from '../src/project-chat/project-chat.types';
import type { ChatAgentSnapshot } from '../src/model-chat/chat-group.types';
import type { Request } from 'express';

describe.skipIf(!adminUrl).sequential('Project chat admission reserves — owned PostgreSQL', () => {
    let f: Awaited<ReturnType<typeof projectChatAdmissionFixture>>;
    beforeAll(async () => { f = await projectChatAdmissionFixture(); });
    beforeEach(async () => { await f.setup(); });
    afterEach(async () => { try { expect(f.provider.infer).not.toHaveBeenCalled(); expect((await f.pool.query('SELECT * FROM model_usage_calls')).rows).toEqual([]); } finally { await f.cleanup(); } });
    afterAll(async () => { await f?.close(); });
    const other = (lane: AdmissionLane): AdmissionLane => lane === 'server' ? 'device-codex' : 'server';
    const rejected = (result: PromiseSettledResult<unknown>) => result.status === 'rejected' && result.reason?.status === 409;

    it.each(['server', 'device-codex'] as const)('reserves the twentieth author slot away from a saturated %s lane without enlarging the total cap', async lane => {
        await f.seed(19, [{ lane }]);
        await expect(f.send([lane])).rejects.toHaveProperty('status', 409);
        expect(await f.count()).toBe(19);
        const accepted = await f.send([other(lane)]); expect(accepted.message.status).toBe('queued');
        expect(await f.count()).toBe(20);
        await expect(f.send([other(lane)])).rejects.toHaveProperty('status', 409);
    });

    it.each(['server', 'device-codex'] as const)('reserves the hundredth project slot away from %s across authors and rooms', async lane => {
        const otherRoom = await f.room(); await f.seed(99, [{ lane }], { authors: 'others', roomId: otherRoom.id });
        await expect(f.send([lane])).rejects.toHaveProperty('status', 409);
        expect(await f.count()).toBe(99);
        await f.send([other(lane)]); expect(await f.count()).toBe(100);
        await expect(f.send([other(lane)])).rejects.toHaveProperty('status', 409);
    });

    it('counts a mixed pending question once in each lane and two same-lane agents only once', async () => {
        await f.seed(18, [{ lane: 'server' }, { lane: 'device-codex' }]);
        await f.send(['server', 'device-codex']); expect(await f.count()).toBe(19);
        await expect(f.send(['server'])).rejects.toHaveProperty('status', 409);
        await expect(f.send(['device-codex'])).rejects.toHaveProperty('status', 409);
        await f.pool.query('DELETE FROM project_chat_messages WHERE project_id=$1', [projectId]);
        await f.seed(18, [{ lane: 'server' }, { lane: 'server', secondServer: true }]);
        await f.send(['server']); expect(await f.count()).toBe(19);
        await expect(f.send(['server'])).rejects.toHaveProperty('status', 409);
        await f.send(['device-codex']); expect(await f.count()).toBe(20);
    });

    it.each(['done', 'failed'] as const)('does not charge a %s child to its lane while retaining the total pending-source cap', async status => {
        await f.seed(19, [{ lane: 'server', status }, { lane: 'device-codex' }]);
        await f.send(['server']); expect(await f.count()).toBe(20);
        await expect(f.send(['server'])).rejects.toHaveProperty('status', 409);
    });

    it('classifies accepted work by the exact immutable model pin rather than the mutable model head', async () => {
        await f.seed(19, [{ lane: 'device-codex' }]);
        await f.pool.query("UPDATE model_catalog SET descriptor=jsonb_set(jsonb_set(descriptor,'{runtime}',to_jsonb('ollama'::text)),'{manifestSha256}',to_jsonb($2::text)) WHERE id=$1", ['model-admission-device', 'c'.repeat(64)]);
        await f.send(['server']); expect(await f.count()).toBe(20);
    });

    it.each(['server', 'device-codex'] as const)('conservatively charges missing pinned metadata to both lanes when admitting %s', async incoming => {
        await f.seed(19, [{ lane: 'device-codex', unknownPin: true }]);
        await expect(f.send([incoming])).rejects.toHaveProperty('status', 409);
        expect(await f.count()).toBe(19);
    });

    it('keeps exact send replay and human messages usable when legacy accepted work already fills the old total cap', async () => {
        const requestKey = randomUUID(), accepted = await f.send(['device-codex'], requestKey);
        await f.seed(19, [{ lane: 'device-codex' }]);
        const classify = vi.spyOn(f.inference, 'transport');
        const rows = (await f.pool.query('SELECT * FROM project_chat_messages WHERE project_id=$1 ORDER BY position', [projectId])).rows;
        expect((await f.send(['device-codex'], requestKey)).message.id).toBe(accepted.message.id);
        expect(classify).not.toHaveBeenCalled();
        await expect(f.send(['server'])).rejects.toHaveProperty('status', 409);
        classify.mockClear();
        const human = await f.send([]); expect(human.message.status).toBe('done');
        expect(classify).not.toHaveBeenCalled();
        expect((await f.pool.query("SELECT * FROM project_chat_messages WHERE project_id=$1 AND id<>$2 ORDER BY position", [projectId, human.message.id])).rows).toEqual(rows);
    });

    it('uses only unfinished retry recipients, preserves a paid sibling and replays the accepted retry without quota work', async () => {
        const accepted = await f.send(['server', 'device-codex']);
        await f.pool.query("UPDATE project_chat_messages SET status='failed' WHERE id=$1 OR source_message_id=$1", [accepted.message.id]);
        await f.pool.query("UPDATE project_chat_messages SET status='done',content='PAID PRESERVED SIBLING' WHERE source_message_id=$1 AND snapshot->>'agentId'=$2", [accepted.message.id, f.cards['device-codex']]);
        const paid = (await f.pool.query("SELECT * FROM project_chat_messages WHERE source_message_id=$1 AND kind='agent' AND status='done'", [accepted.message.id])).rows[0];
        await f.seed(19, [{ lane: 'device-codex' }]);
        const key = randomUUID(); await f.service.retry(req(), projectId, accepted.message.id, { requestKey: key });
        expect(await f.count()).toBe(20);
        expect((await f.pool.query('SELECT * FROM project_chat_messages WHERE id=$1', [paid.id])).rows[0]).toEqual(paid);
        expect((await f.service.retry(req(), projectId, accepted.message.id, { requestKey: key })).message.id).toBe(accepted.message.id);
    });

    it('classifies incoming pinned metadata through the caller transaction rather than acquiring another model pool connection', async () => {
        const original = f.inference.transport.bind(f.inference);
        const read: (request: Request, id: string, snapshot: ChatAgentSnapshot, db?: ProjectChatDb) => ReturnType<typeof original> = original;
        const classify = vi.spyOn(f.inference, 'transport').mockImplementation(async (request, id, snapshot, db?: ProjectChatDb) => {
            expect(db).toBeDefined();
            const scoped = { query: vi.fn(db!.query.bind(db)) } as unknown as ProjectChatDb;
            const transport = await read(request, id, snapshot, scoped);
            expect(vi.mocked(scoped.query).mock.calls.some(args => String(args[0]).includes('FROM model_catalog'))).toBe(true);
            return transport;
        });
        await f.send(['server']); expect(classify).toHaveBeenCalledTimes(1);
    });

    it.each(['author', 'project'] as const)('serializes concurrent same-lane %s admissions so only one may consume the last lane slot', async scope => {
        await f.seed(scope === 'author' ? 18 : 98, [{ lane: 'device-codex' }], { authors: scope === 'author' ? 'own' : 'others' });
        const results = await Promise.allSettled([f.send(['device-codex']), f.send(['device-codex'])]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(rejected)).toHaveLength(1);
        expect(await f.count()).toBe(scope === 'author' ? 19 : 99);
        await f.send(['server']); expect(await f.count()).toBe(scope === 'author' ? 20 : 100);
    });
});
