import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { adminUrl, bounded, deferred, developer, projectChatIsolationFixture, projectId, req, reply, waitFor } from './project-chat-isolation.fixture';

describe.skipIf(!adminUrl).sequential('Team chat bridge fault isolation — actual PostgreSQL runtime', () => {
    let f: Awaited<ReturnType<typeof projectChatIsolationFixture>>;
    beforeAll(async () => { f = await projectChatIsolationFixture(); });
    beforeEach(async () => { await f.setup(); });
    afterEach(async () => { await f.cleanup(); });
    afterAll(async () => { await f?.close(); });
    const done = (id: string) => waitFor(() => f.rows(id), rows => rows.find(row => row.id === id)?.status === 'done');

    it('publishes a server sibling before held Codex settles and creates the summary only after both settle', async () => {
        const device = await f.agent('Device', 'device-codex'), server = await f.agent('Server'), gate = f.hold(device.id);
        await f.configure(f.defaultRoom, [device.id, server.id]);
        try {
            const accepted = await f.send(f.defaultRoom, [device.id, server.id]); await bounded(gate.entered);
            const partial = await waitFor(() => f.rows(accepted.message.id), rows => rows.some(row => row.snapshot?.agentId === server.id && row.status === 'done'));
            expect(partial.find(row => row.kind === 'summary')).toBeUndefined();
            expect(partial.find(row => row.snapshot?.agentId === device.id)?.status).toBe('running');
            expect(f.active).toEqual({ server: 0, 'device-codex': 1 });
            expect(JSON.stringify(f.calls.find(call => call.agentId === server.id)?.messages)).not.toContain('HELD OUTPUT');
            gate.release(); const complete = await done(accepted.message.id);
            expect(complete.find(row => row.kind === 'summary')?.content).toContain('Answer ' + server.id);
            expect(complete.find(row => row.kind === 'summary')?.content).toContain('HELD OUTPUT ' + device.id);
            expect(f.calls).toHaveLength(2);
        } finally { gate.release(); }
    });

    it('stores human-only and singleton agent messages without a summary or another inference', async () => {
        const human = await f.send(f.defaultRoom, []);
        expect((await f.rows(human.message.id)).map(row => row.kind)).toEqual(['user']);
        const server = await f.agent('Solo'); await f.configure(f.defaultRoom, [server.id]);
        const accepted = await f.send(f.defaultRoom, [server.id]); await f.service.runner.waitIdle();
        expect((await f.rows(accepted.message.id)).map(row => [row.kind,row.status])).toEqual([['user','done'],['agent','done']]);
        expect(f.calls).toHaveLength(1);
    });

    it('keeps two failed answers separate without creating a summary', async () => {
        const server = await f.agent('Server'), device = await f.agent('Device', 'device-codex');
        await f.configure(f.defaultRoom, [server.id, device.id]);
        for (const agent of [server,device]) f.handlers.set(agent.id, async () => { throw new ServiceUnavailableException('Owned unavailable model'); });
        const accepted = await f.send(f.defaultRoom, [server.id, device.id]); await f.service.runner.waitIdle();
        const rows = await f.rows(accepted.message.id);
        expect(rows.map(row => [row.kind,row.status])).toEqual([['user','failed'],['agent','failed'],['agent','failed']]);
        expect(rows.filter(row => row.kind === 'agent').every(row => row.error.includes('Owned unavailable model'))).toBe(true);
        expect(f.calls).toHaveLength(2);
    });

    it.each(['', 'Прежний сохранённый итог'])('finishes an accepted legacy singleton without rewriting historical content %j', async content => {
        const server=await f.agent('Legacy');await f.configure(f.defaultRoom,[server.id]);
        const schedule=vi.spyOn(f.service.runner,'schedule').mockImplementation(()=>undefined);
        let sourceId:string;
        try {
            const accepted=await f.send(f.defaultRoom,[server.id]);sourceId=accepted.message.id;
            await f.pool.query(`INSERT INTO project_chat_messages(id,project_id,room_id,kind,reply_to_id,source_message_id,status,content,generation)
                SELECT $1,project_id,room_id,'summary',id,id,'queued',$3,generation FROM project_chat_messages WHERE id=$2`,[randomUUID(),sourceId,content]);
        } finally {schedule.mockRestore();}
        f.service.runner.schedule(projectId,f.defaultRoom);await f.service.runner.waitIdle();
        const rows=await f.rows(sourceId!),summary=rows.find(row=>row.kind==='summary');
        expect(rows[0].status).toBe('done');expect(f.calls).toHaveLength(1);
        if(content)expect(summary).toMatchObject({status:'done',content,lease_until:null});
        else expect(summary).toBeUndefined();
    });

    it('keeps FIFO inside a room while a different room completes independently of held Codex', async () => {
        const device = await f.agent('Device', 'device-codex'), server = await f.agent('Server'), left = await f.room(), right = await f.room(), gate = f.hold(device.id);
        await f.configure(left.id, [device.id, server.id]); await f.configure(right.id, [server.id]);
        try {
            const first = await f.send(left.id, [device.id]); await bounded(gate.entered);
            const second = await f.send(left.id, [server.id]); const independent = await f.send(right.id, [server.id]);
            await done(independent.message.id);
            expect(f.calls.some(call => call.sourceId === second.message.id)).toBe(false);
            expect((await f.rows(second.message.id))[0].status).toBe('queued');
            gate.release(); await done(first.message.id); await done(second.message.id);
            expect(f.calls.filter(call => call.agentId === server.id).map(call => call.sourceId)).toEqual([independent.message.id, second.message.id]);
        } finally { gate.release(); }
    });

    it('bounds all rooms of a project to one active server and one active device inference', async () => {
        const server = await f.agent('Server'), device = await f.agent('Device', 'device-codex'), heldServer = f.hold(server.id), heldDevice = f.hold(device.id);
        const rooms = await Promise.all([f.room(), f.room(), f.room(), f.room()]);
        for (const room of rooms) await f.configure(room.id, [server.id, device.id]);
        try {
            await f.send(rooms[0].id, [device.id]); await bounded(heldDevice.entered);
            await f.send(rooms[1].id, [server.id]); await bounded(heldServer.entered);
            const extraServer = await f.send(rooms[2].id, [server.id]), extraDevice = await f.send(rooms[3].id, [device.id]);
            await waitFor(() => f.rows(extraServer.message.id), rows => rows[0].status === 'running');
            await waitFor(() => f.rows(extraDevice.message.id), rows => rows[0].status === 'running');
            expect(f.calls).toHaveLength(2); expect(f.maximum).toEqual({ server: 1, 'device-codex': 1 });
            heldServer.release(); await done(extraServer.message.id);
            expect(f.calls.some(call => call.sourceId === extraDevice.message.id)).toBe(false);
            expect(f.active['device-codex']).toBe(1);
        } finally { heldServer.release(); heldDevice.release(); }
    });

    it('retains a successful sibling and its receipt when offline Codex fails, then retries only the missing answer', async () => {
        const device = await f.agent('Device', 'device-codex'), server = await f.agent('Server');
        await f.knowledge('server', 'Approved server knowledge', server.id);
        await f.configure(f.defaultRoom, [device.id, server.id]);
        f.handlers.set(device.id, async () => { throw new ServiceUnavailableException('Device offline fixture'); });
        const accepted = await f.send(f.defaultRoom, [device.id, server.id]); await f.service.runner.waitIdle();
        const before = await f.rows(accepted.message.id), successful = before.find(row => row.snapshot?.agentId === server.id)!;
        expect(successful).toMatchObject({ status: 'done', learning: { status: 'applied' } }); expect(before[0].status).toBe('failed');
        expect(before.some(row => row.kind === 'summary')).toBe(false);
        f.handlers.delete(device.id);
        await f.service.retry(req(), projectId, accepted.message.id, { requestKey: randomUUID() }); await f.service.runner.waitIdle();
        expect(f.calls.filter(call => call.agentId === server.id)).toHaveLength(1); expect(f.calls.filter(call => call.agentId === device.id)).toHaveLength(2);
        expect((await f.rows(accepted.message.id)).find(row => row.id === successful.id)).toEqual(successful);
        const completed = await f.rows(accepted.message.id);
        expect(completed[0].status).toBe('done');
        expect(completed.find(row => row.kind === 'summary')).toMatchObject({status:'done'});
        expect(completed.find(row => row.kind === 'summary')?.content).toContain('Answer ' + server.id);
        expect(completed.find(row => row.kind === 'summary')?.content).toContain('Answer ' + device.id);
    });

    it('cancels only a waiting question without waiting for or aborting a different room provider', async () => {
        const device = await f.agent('Device', 'device-codex'), server = await f.agent('Server'), left = await f.room(), waiting = await f.room(), healthy = await f.room(), gate = f.hold(device.id);
        await f.configure(left.id, [device.id]); await f.configure(waiting.id, [device.id]); await f.configure(healthy.id, [server.id]);
        try {
            await f.send(left.id, [device.id]); await bounded(gate.entered);
            const pending = await f.send(waiting.id, [device.id]);
            await waitFor(() => f.rows(pending.message.id), rows => rows[0].status === 'running');
            await bounded(f.service.cancel(req(), projectId, pending.message.id, {}, waiting.id));
            const next = await f.send(healthy.id, [server.id]); await done(next.message.id);
            expect(f.calls.find(call => call.agentId === device.id)?.signal.aborted).toBe(false);
            gate.release(); await f.service.runner.waitIdle();
            expect(f.calls.some(call => call.sourceId === pending.message.id)).toBe(false);
            expect((await f.rows(pending.message.id))[0].status).toBe('cancelled');
        } finally { gate.release(); }
    });

    it('rechecks private audience after waiting for a transport permit and publishes no late private output', async () => {
        const device = await f.agent('Device', 'device-codex'), left = await f.room(), privateRoom = await f.room('PRIVATE'), gate = f.hold(device.id);
        await f.configure(left.id, [device.id]); await f.configure(privateRoom.id, [device.id]);
        try {
            await f.send(left.id, [device.id]); await bounded(gate.entered);
            const pending = await f.send(privateRoom.id, [device.id]);
            await waitFor(() => f.rows(pending.message.id), rows => rows[0].status === 'running');
            await f.pool.query('DELETE FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND email=$3', [projectId, privateRoom.id, developer.email]);
            gate.release(); await f.service.runner.waitIdle();
            expect(f.calls.some(call => call.sourceId === pending.message.id)).toBe(false);
            expect((await f.rows(pending.message.id)).every(row => !row.content.includes('HELD OUTPUT'))).toBe(true);
            expect((await f.rows(pending.message.id))[0].status).toBe('failed');
        } finally { gate.release(); }
    });

    it('startup and legacy schedule(project) discover all queued rooms without multiplying a project transport lane', async () => {
        const device = await f.agent('Device', 'device-codex'), server = await f.agent('Server'), left = await f.room(), right = await f.room(), gate = f.hold(device.id);
        await f.configure(left.id, [device.id]); await f.configure(right.id, [server.id]);
        const schedule = vi.spyOn(f.service.runner, 'schedule').mockImplementation(() => undefined);
        try {
            await f.send(left.id, [device.id]); const next = await f.send(right.id, [server.id]); schedule.mockRestore();
            await f.service.runner.start(); f.service.runner.schedule(projectId);
            await bounded(gate.entered); await done(next.message.id);
            expect(f.calls).toHaveLength(2); expect(f.maximum).toEqual({ server: 1, 'device-codex': 1 });
        } finally { schedule.mockRestore(); gate.release(); }
    });

    it('aborts the held sibling when another response observes revoked project access after paid dispatch', async () => {
        const device = await f.agent('Device', 'device-codex'), server = await f.agent('Server'), gate = f.hold(device.id, true);
        await f.configure(f.defaultRoom, [device.id, server.id]);
        f.handlers.set(server.id, async () => {
            await bounded(gate.entered);
            await f.pool.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2', [projectId, developer.email]);
            return reply('REVOKED SERVER OUTPUT');
        });
        try {
            const accepted = await f.send(f.defaultRoom, [device.id, server.id]);
            await bounded(gate.aborted); await bounded(f.service.runner.waitIdle());
            const rows = await f.rows(accepted.message.id);
            expect(rows[0].status).toBe('failed');
            expect(rows.every(row => !row.content.includes('HELD OUTPUT') && !row.content.includes('REVOKED SERVER OUTPUT'))).toBe(true);
            expect(f.calls).toHaveLength(2);
        } finally { gate.release(); }
    });

    it('stop aborts both active lanes and queued waiters, and late paid transport results cannot become answers', async () => {
        const device = await f.agent('Device', 'device-codex'), server = await f.agent('Server'), left = await f.room(), right = await f.room(), queued = await f.room();
        const deviceGate = f.hold(device.id, true), serverGate = f.hold(server.id, true);
        for (const room of [left, right, queued]) await f.configure(room.id, [device.id, server.id]);
        const first = await f.send(left.id, [device.id]); await bounded(deviceGate.entered);
        const second = await f.send(right.id, [server.id]); await bounded(serverGate.entered);
        const waiting = await f.send(queued.id, [device.id, server.id]);
        await waitFor(() => f.rows(waiting.message.id), rows => rows[0].status === 'running');
        await bounded(f.service.runner.stop());
        await bounded(Promise.all([deviceGate.aborted, serverGate.aborted]));
        expect(f.calls).toHaveLength(2); expect(f.active).toEqual({ server: 0, 'device-codex': 0 });
        for (const source of [first, second, waiting]) expect((await f.rows(source.message.id)).every(row => row.kind === 'user' || !row.content.includes('HELD OUTPUT'))).toBe(true);
        f.service.runner.schedule(projectId); await f.service.runner.waitIdle(); expect(f.calls).toHaveLength(2);
    });

    it('a stop while real SQL claim is returning cancels the accepted generation before any provider dispatch', async () => {
        const server = await f.agent('Server'); await f.configure(f.defaultRoom, [server.id]);
        const reached = deferred(), release = deferred(), original = f.service.repository.claim.bind(f.service.repository);
        let pause = true;
        const claim = vi.spyOn(f.service.repository, 'claim').mockImplementation(async (...args) => {
            const job = await original(...args);
            if (job && pause) { pause = false; reached.resolve(); await release.promise; }
            return job;
        });
        try {
            const accepted = await f.send(f.defaultRoom, [server.id]); await bounded(reached.promise);
            const stopping = f.service.runner.stop(); release.resolve(); await bounded(stopping);
            expect(f.calls).toEqual([]); expect((await f.rows(accepted.message.id)).every(row => row.status === 'cancelled')).toBe(true);
            expect((await f.pool.query('SELECT * FROM model_usage_calls')).rows).toEqual([]);
        } finally { release.resolve(); claim.mockRestore(); }
    });
});
