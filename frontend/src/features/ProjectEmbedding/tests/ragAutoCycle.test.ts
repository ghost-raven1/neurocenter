import { describe, expect, it } from 'vitest';
import { RAG_AUTO_CYCLE_MAX_ATTEMPTS, ragAutoCycleDecision } from '../ragAutoCycle';
import type { IProjectReindexPlan } from '../reindex';

const pin = 'b'.repeat(64);
const plan = (patch: Partial<IProjectReindexPlan> = {}): IProjectReindexPlan => ({
    id: 'plan-1',
    projectId: 'p1',
    state: 'applied',
    digest: 'a'.repeat(64),
    approved: true,
    data: {
        context: { revision: 1, generation: `initial-${'a'.repeat(32)}`, dataRevision: 1 },
        modelId: 'model-1',
        modelPin: pin,
        profile: { provider: 'openai', model: `neurocenter/model-1/sha256/${pin}`, dimension: 384 },
        sourceSnapshot: null,
        rowCount: 10,
        requiredBytes: 1024,
    },
    progress: 100,
    message: 'ok',
    createdAt: '2026-11-01T00:00:00Z',
    ...patch,
});
const local = (state: string) => ({ jobId: 'job-1', state, message: 'msg', percent: null });

describe('ragAutoCycleDecision', () => {
    const failedLocal = plan({ local: local('failed') });
    it('stays inactive while the flag is off', () => {
        expect(ragAutoCycleDecision({ flagEnabled: false, plan: failedLocal, attempts: 0 })).toEqual({
            action: 'none',
            reason: 'flag-off',
        });
    });
    it('stays inactive without a plan', () => {
        expect(ragAutoCycleDecision({ flagEnabled: true, plan: undefined, attempts: 0 })).toEqual({
            action: 'none',
            reason: 'no-plan',
        });
    });
    it.each([
        'preparing',
        'needs_input',
        'building',
        'ready',
        'failed',
        'cancelling',
        'cancelled',
        'stale',
    ])('does not retry a plan in the %s state', (state) => {
        expect(ragAutoCycleDecision({ flagEnabled: true, plan: plan({ state, local: local('failed') }), attempts: 0 })).toEqual(
            { action: 'none', reason: 'not-applied' },
        );
    });
    it('does not retry an applied plan without a local step', () => {
        expect(ragAutoCycleDecision({ flagEnabled: true, plan: plan({}), attempts: 0 })).toEqual({
            action: 'none',
            reason: 'no-local-step',
        });
    });
    it.each(['waiting', 'pending', 'queued', 'running', 'reconciling', 'succeeded'])(
        'does not retry a local step in the %s state',
        (state) => {
            expect(ragAutoCycleDecision({ flagEnabled: true, plan: plan({ local: local(state) }), attempts: 0 })).toEqual({
                action: 'none',
                reason: 'local-not-failed',
            });
        },
    );
    it.each(['failed', 'cancelled'])('retries a %s local step of an applied plan', (state) => {
        expect(ragAutoCycleDecision({ flagEnabled: true, plan: plan({ local: local(state) }), attempts: 0 })).toEqual({
            action: 'retryLocal',
            reason: 'local-failed',
        });
    });
    it('retries up to the cap and stops at it', () => {
        for (let attempts = 0; attempts < RAG_AUTO_CYCLE_MAX_ATTEMPTS; attempts += 1) {
            expect(
                ragAutoCycleDecision({ flagEnabled: true, plan: failedLocal, attempts }).action,
            ).toBe('retryLocal');
        }
        expect(ragAutoCycleDecision({ flagEnabled: true, plan: failedLocal, attempts: RAG_AUTO_CYCLE_MAX_ATTEMPTS })).toEqual({
            action: 'none',
            reason: 'at-cap',
        });
    });
    it('honours a custom cap', () => {
        expect(ragAutoCycleDecision({ flagEnabled: true, plan: failedLocal, attempts: 0, maxAttempts: 1 })).toEqual({
            action: 'retryLocal',
            reason: 'local-failed',
        });
        expect(ragAutoCycleDecision({ flagEnabled: true, plan: failedLocal, attempts: 1, maxAttempts: 1 })).toEqual({
            action: 'none',
            reason: 'at-cap',
        });
    });
});
