import { describe, expect, it } from 'vitest';
import {
    BACKGROUND_AGENT_CONTEXT_SOURCES,
    backgroundAgentDigest,
    normalizeBackgroundAgentContext,
    normalizeBackgroundAgentPayload,
} from '../../../../shared/background-agent.cjs';
import {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    assertAgentResultAccepted,
    normalizeVerificationIntent,
} from '../../../../shared/agent-result-verification.cjs';

const base = () => ({
    protocol: 'background-agent-v1',
    workflowId: '11111111-1111-4111-8111-111111111111',
    requestId: '11111111-1111-4111-8111-111111111111',
    projectId: 'prj-bg',
    method: 'openspec',
    methodVersion: '1.15.0',
    instruction: 'Фоновая задача',
    checks: [{ command: 'npm', args: ['test'] }],
    deadlineAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    runtime: 'opencode',
});

describe('background-agent payload contract (FR-305, reuses FR-304 verification)', () => {
    it('normalizes an immutable task with a server-fixed method version and declared checks', () => {
        const checked = normalizeBackgroundAgentPayload(base());
        expect(checked.method).toBe('openspec');
        expect(checked.methodVersion).toBe('1.15.0');
        expect(checked.checks).toEqual([{ command: 'npm', args: ['test'] }]);
        expect(checked.runtime).toBe('opencode');
        // The method version is server-fixed: a mismatching version is rejected, never trusted from the caller.
        expect(() => normalizeBackgroundAgentPayload({ ...base(), methodVersion: '9.9.9' })).toThrow();
    });

    it('pins the declared verification intent (checks) so the result must describe exactly these', () => {
        const checked = normalizeBackgroundAgentPayload(base());
        expect(() => normalizeBackgroundAgentPayload({ ...base(), checks: [] })).toThrow();
        // argv only: a shell-injection command (spaces/&&) is a format violation, not a valid check.
        expect(() =>
            normalizeBackgroundAgentPayload({ ...base(), checks: [{ command: 'npm && evil', args: [] }] }),
        ).toThrow();
        const intent = normalizeVerificationIntent({
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            checks: checked.checks,
        });
        const result = {
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            state: 'succeeded',
            stage: 'completed',
            checks: [{ command: 'npm', args: ['test'], exitCode: 0, signal: null, state: 'passed' }],
        };
        expect(assertAgentResultAccepted(result, false, intent).state).toBe('succeeded');
    });

    it('selects configurable context sources by a fixed set and bounds each descriptor', () => {
        expect(BACKGROUND_AGENT_CONTEXT_SOURCES).toEqual(['project', 'computer', 'web']);
        const checked = normalizeBackgroundAgentPayload({
            ...base(),
            context: { project: { data: true, catalog: true }, web: { enabled: true } },
        });
        expect(Object.keys(checked.context ?? {})).toEqual(['project', 'web']);
        expect(checked.context?.project).toEqual({ data: true, catalog: true });
        // Unknown source is rejected (extending = update the fixed set + a provider).
        expect(() => normalizeBackgroundAgentContext({ hacker: {} })).toThrow();
        // A descriptor is bounded; an oversized one is rejected.
        expect(() => normalizeBackgroundAgentContext({ project: { blob: 'x'.repeat(8192) } })).toThrow();
    });

    it('is fail-closed on shape: uuid, runtime, deadline, and unknown fields', () => {
        expect(() => normalizeBackgroundAgentPayload({ ...base(), workflowId: 'nope' })).toThrow();
        expect(() => normalizeBackgroundAgentPayload({ ...base(), runtime: 'cursor' })).toThrow();
        expect(() => normalizeBackgroundAgentPayload({ ...base(), deadlineAt: 'not-a-date' })).toThrow();
        expect(() => normalizeBackgroundAgentPayload({ ...base(), smuggled: true })).toThrow();
        expect(() => normalizeBackgroundAgentPayload(null)).toThrow();
    });

    it('produces a stable idempotency digest over the normalized payload', () => {
        // One task: the digest must be stable across re-normalization of the same payload.
        const task = base();
        const digest = backgroundAgentDigest(task);
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
        expect(backgroundAgentDigest(normalizeBackgroundAgentPayload(task))).toBe(digest);
        expect(backgroundAgentDigest({ ...task, instruction: 'another' })).not.toBe(digest);
    });
});
