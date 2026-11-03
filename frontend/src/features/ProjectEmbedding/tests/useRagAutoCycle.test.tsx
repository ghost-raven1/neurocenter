// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RAG_AUTO_CYCLE_COOLDOWN_MS } from '../ragAutoCycle';
import { useRagAutoCycle } from '../hooks/useRagAutoCycle';
import type { useProjectReindex } from '../hooks/useProjectReindex';
import type { IProjectReindexPlan } from '../reindex';

const flagMock = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../FeatureFlags/hooks/useFeatureAvailability', () => ({
    useFeatureAvailability: () => ({ enabled: flagMock.enabled }),
}));

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

const makeReindex = (
    value: { plan?: IProjectReindexPlan; retryLocal?: () => void },
): ReturnType<typeof useProjectReindex> =>
    ({
        plan: value.plan,
        busy: false,
        error: '',
        pending: false,
        request: async () => undefined,
        start: () => undefined,
        cancel: () => undefined,
        retry: () => undefined,
        retryLocal: value.retryLocal ?? (() => undefined),
    }) as unknown as ReturnType<typeof useProjectReindex>;

function Harness({
    planValue,
    retryLocal,
}: {
    planValue: IProjectReindexPlan | undefined;
    retryLocal: () => void;
}): JSX.Element {
    const auto = useRagAutoCycle(makeReindex({ plan: planValue, retryLocal }));
    return (
        <div>
            {String(auto.enabled)}|{auto.attempts}|{auto.scheduled ? 's' : '-'}|{auto.exhausted ? 'e' : '-'}
        </div>
    );
}

let root: Root;
let container: HTMLDivElement;
const failed = plan({ local: local('failed') });
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    flagMock.enabled = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
const render = async (planValue: IProjectReindexPlan | undefined, retryLocal: () => void): Promise<void> => {
    await act(async () => {
        root.render(<Harness planValue={planValue} retryLocal={retryLocal} />);
    });
};

describe('useRagAutoCycle', () => {
    it('retries the failed local step automatically after the cooldown', async () => {
        const retryLocal = vi.fn();
        await render(failed, retryLocal);
        expect(retryLocal).not.toHaveBeenCalled();
        // The attempt is counted when the retry executes, not when it is scheduled.
        expect(container.textContent).toBe('true|0|s|-');
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS);
        });
        expect(retryLocal).toHaveBeenCalledOnce();
        expect(container.textContent).toBe('true|1|-|-');
        // The server re-queues the local step; a fresh plan state clears the schedule.
        await render(plan({ local: local('queued') }), retryLocal);
        expect(container.textContent).toBe('true|1|-|-');
    });

    it('does not consume an extra attempt on StrictMode remount', async () => {
        const retryLocal = vi.fn();
        await act(async () => {
            root.render(
                <StrictMode>
                    <Harness planValue={failed} retryLocal={retryLocal} />
                </StrictMode>,
            );
        });
        // Mount, simulated unmount, remount: one schedule survives, no extra attempt.
        expect(container.textContent).toBe('true|0|s|-');
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS);
        });
        expect(retryLocal).toHaveBeenCalledOnce();
        expect(container.textContent).toBe('true|1|-|-');
    });

    it('drives repeated local failures up to the cap and then stops', async () => {
        const retryLocal = vi.fn();
        await render(failed, retryLocal);
        for (let round = 1; round <= 3; round += 1) {
            await act(async () => {
                vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS);
            });
            expect(retryLocal).toHaveBeenCalledTimes(round);
            if (round < 3) {
                // The retried step runs and fails again.
                await render(plan({ local: local('queued') }), retryLocal);
                await render(plan({ local: local('failed') }), retryLocal);
            }
        }
        // A fourth failure is no longer retried automatically.
        await render(plan({ local: local('queued') }), retryLocal);
        await render(plan({ local: local('failed') }), retryLocal);
        expect(container.textContent).toBe('true|3|-|e');
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS * 2);
        });
        expect(retryLocal).toHaveBeenCalledTimes(3);
    });

    it('does not double-schedule on re-render with the same failure', async () => {
        const retryLocal = vi.fn();
        await render(failed, retryLocal);
        await render(plan({ local: local('failed') }), retryLocal);
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS);
        });
        expect(retryLocal).toHaveBeenCalledOnce();
    });

    it('does nothing while the flag is off', async () => {
        flagMock.enabled = false;
        const retryLocal = vi.fn();
        await render(failed, retryLocal);
        expect(container.textContent).toBe('false|0|-|-');
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS * 10);
        });
        expect(retryLocal).not.toHaveBeenCalled();
    });

    it('does not retry a server-side plan failure', async () => {
        const retryLocal = vi.fn();
        await render(plan({ state: 'failed', local: local('failed') }), retryLocal);
        expect(container.textContent).toBe('true|0|-|-');
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS * 10);
        });
        expect(retryLocal).not.toHaveBeenCalled();
    });

    it('does not retry a succeeded local step', async () => {
        const retryLocal = vi.fn();
        await render(plan({ local: local('succeeded') }), retryLocal);
        expect(container.textContent).toBe('true|0|-|-');
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS * 10);
        });
        expect(retryLocal).not.toHaveBeenCalled();
    });

    it('discards a pending retry when the plan goes away', async () => {
        const retryLocal = vi.fn();
        await render(failed, retryLocal);
        await render(undefined, retryLocal);
        await act(async () => {
            vi.advanceTimersByTime(RAG_AUTO_CYCLE_COOLDOWN_MS * 10);
        });
        expect(retryLocal).not.toHaveBeenCalled();
    });
});
