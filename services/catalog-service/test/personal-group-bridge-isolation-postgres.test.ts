import 'reflect-metadata';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { bounded, connection, deferred, personalGroupBridgeFixture, reply, type PersonalGroupBridgeFixture } from './personal-group-bridge-isolation.fixture';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeatureEnabled: vi.fn(async () => undefined), requireFeaturesEnabled: vi.fn(async () => undefined) }));

describe.skipIf(!connection)('Personal group bridge isolation — disposable PostgreSQL', () => {
    let f: PersonalGroupBridgeFixture;
    beforeAll(async () => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'personal-bridge-test-only');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())), { status: 200 })));
        f = await personalGroupBridgeFixture();
    });
    afterEach(async () => { await f?.reset(); });
    afterAll(async () => { await f?.cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it('commits the server answer while an earlier selected Codex remains held, preserving public and SQL target order', async () => {
        const codex = await f.agent('Codex first', f.codex), server = await f.agent('Server second');
        const started = deferred(), held = deferred();
        f.setProvider(async model => { if (model.runtime === 'device-codex') { started.resolve(); await held.promise; } return reply('Answer ' + model.id); });
        const initial = await f.create([codex, server]), pending = f.send(initial);
        try {
            await bounded(started.promise);
            const during = await f.read(initial.conversation.id), turn = during.turns[0];
            expect(turn.status).toBe('pending');
            expect(turn.targetAgentIds).toEqual([codex, server]);
            expect(turn.responses?.map(item => [item.agentId, item.status])).toEqual([[codex, 'pending'], [server, 'done']]);
            expect(turn.responses?.[1].answer?.content).toBe('Answer ' + f.server.id);
            expect((await f.db.query('SELECT target_agent_ids FROM model_chat_turns WHERE id=$1', [turn.id])).rows[0].target_agent_ids).toEqual([codex, server]);
        } finally { held.resolve(); await bounded(pending); }
        const final = await f.read(initial.conversation.id);
        expect(final.turns[0].responses?.map(item => item.agentId)).toEqual([codex, server]);
        expect(final.turns[0].status).toBe('done');
        expect(f.calls.map(item => item.agentId)).toEqual([server, codex]);
        const aggregate = (await f.db.query("SELECT answer->>'content' AS content FROM model_chat_turns WHERE id=$1", [final.turns[0].id])).rows[0].content;
        expect(aggregate.indexOf('Codex first')).toBeLessThan(aggregate.indexOf('Server second'));
    });

    it('keeps completed server siblings through a Codex failure and retries only the failed paid participant', async () => {
        const codex = await f.agent('Codex', f.codex), server = await f.agent('Server'); let fail = true;
        f.setProvider(async model => { if (model.runtime === 'device-codex' && fail) throw new ConflictException('Мост недоступен'); return reply('Answer ' + model.id); });
        let detail = await f.send(await f.create([codex, server]));
        expect(detail.turns[0].responses?.map(item => item.status)).toEqual(['failed', 'done']);
        const saved = detail.turns[0].responses![1]; fail = false; detail = await f.retry(detail);
        expect(detail.turns[0].responses?.[1]).toEqual(saved);
        expect(detail.turns[0].status).toBe('done');
        expect(f.calls.map(item => item.agentId)).toEqual([server, codex, codex]);
    });

    it('preserves relative order inside each runtime group without replacing any selected model', async () => {
        const c1 = await f.agent('C1', f.codex), s1 = await f.agent('S1'), c2 = await f.agent('C2', f.codex), s2 = await f.agent('S2');
        const detail = await f.send(await f.create([c1, s1, c2, s2]));
        expect(f.calls.map(item => [item.agentId, item.modelId])).toEqual([[s1, f.server.id], [s2, f.server.id], [c1, f.codex.id], [c2, f.codex.id]]);
        expect(detail.turns[0].responses?.map(item => item.agentId)).toEqual([c1, s1, c2, s2]);
        expect(detail.turns[0].responses?.every(item => item.status === 'done')).toBe(true);
    });

    it('rechecks a changed Codex pin before dispatch without blocking an independent server response', async () => {
        const codex = await f.agent('Codex', f.codex), server = await f.agent('Server');
        f.setProvider(async model => { if (model.runtime === 'ollama') f.changeCodexPin(); return reply('Server remains useful'); });
        const detail = await f.send(await f.create([codex, server]));
        expect(detail.turns[0].responses?.map(item => item.status)).toEqual(['failed', 'done']);
        expect(detail.turns[0].responses?.[0].error).toContain('изменились');
        expect(f.calls.map(item => item.agentId)).toEqual([server]);
    });

    it('still stops the whole round on actual global access revocation and withholds the private late answer', async () => {
        const codex = await f.agent('Codex', f.codex), s1 = await f.agent('S1'), s2 = await f.agent('S2');
        f.setProvider(async () => { f.revokeAccess(); return reply('PRIVATE LATE ANSWER'); });
        const initial = await f.create([codex, s1, s2]);
        await expect(f.send(initial)).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.calls.map(item => item.agentId)).toEqual([s1]);
        expect((await f.db.query('SELECT answer FROM model_chat_agent_responses WHERE conversation_id=$1', [initial.conversation.id])).rows.every(item => item.answer === null)).toBe(true);
    });

    it('cancels a held Codex without losing saved server answers or dispatching a later Codex', async () => {
        const c1 = await f.agent('C1', f.codex), server = await f.agent('Server'), c2 = await f.agent('C2', f.codex);
        const started = deferred(), held = deferred();
        f.setProvider(async (model, signal) => {
            if (model.runtime === 'device-codex') {
                started.resolve(); await Promise.race([held.promise, new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))]);
            }
            return reply('Saved ' + model.id);
        });
        const initial = await f.create([c1, server, c2]), pending = f.send(initial);
        try {
            await bounded(started.promise); const during = await f.read(initial.conversation.id);
            const cancelled = await f.cancel(during); await bounded(pending);
            expect(cancelled.turns[0].responses?.map(item => item.status)).toEqual(['cancelled', 'done', 'cancelled']);
            expect(cancelled.turns[0].responses?.[1].answer?.content).toBe('Saved ' + f.server.id);
            expect(f.calls.map(item => item.agentId)).toEqual([server, c1]);
        } finally { held.resolve(); await bounded(pending); }
    });
});
