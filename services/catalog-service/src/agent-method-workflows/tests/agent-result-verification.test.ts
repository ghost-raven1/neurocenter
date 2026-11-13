import { describe, expect, it } from 'vitest';
import {
    AGENT_METHOD_WORKFLOW_PROTOCOL,
    normalizeAgentMethodWorkflowPayload,
    normalizeAgentMethodWorkflowResult,
} from '../../../../shared/agent-method-workflow.cjs';
import {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    assertAgentResultAccepted,
    normalizeVerificationIntent,
    normalizeVerificationResult,
    verificationIntentDigest,
} from '../../../../shared/agent-result-verification.cjs';

const sha = (letter: string) => letter.repeat(64);
const check = (over: Record<string, unknown> = {}) => ({
    command: 'node',
    args: ['check.cjs'],
    exitCode: 0,
    signal: null,
    state: 'passed',
    ...over,
});
const result = (over: Record<string, unknown> = {}) => ({
    protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
    state: 'succeeded',
    stage: 'completed',
    checks: [check()],
    ...over,
});
const intent = { protocol: AGENT_RESULT_VERIFICATION_PROTOCOL, checks: [{ command: 'node', args: ['check.cjs'] }] };

const deviceRequest = {
    protocol: AGENT_METHOD_WORKFLOW_PROTOCOL,
    workflowId: '11111111-1111-4111-8111-111111111111',
    requestId: '11111111-1111-4111-8111-111111111111',
    projectId: 'project-qa',
    bindingId: sha('a'),
    instanceId: '22222222-2222-4222-8222-222222222222',
    method: 'openspec',
    methodVersion: '1.15.0',
    stage: 'full-cycle',
    instruction: 'Verify selected execution',
    deadlineAt: '2026-12-01T12:00:00.000Z',
    runtime: 'opencode',
    checks: [{ command: 'node', args: ['check.cjs'] }],
};
const devicePayload = normalizeAgentMethodWorkflowPayload(deviceRequest);
const deviceResult = (over: Record<string, unknown> = {}) => ({
    protocol: AGENT_METHOD_WORKFLOW_PROTOCOL,
    workflowId: deviceRequest.workflowId,
    method: 'openspec',
    methodVersion: '1.15.0',
    runtime: 'opencode',
    state: 'succeeded',
    stage: 'completed',
    codeChanged: false,
    changes: [],
    artifacts: [],
    checks: [check()],
    ...over,
});

describe('universal verification contract (FR-304)', () => {
    it('accepts a result that carries real exit-code evidence', () => {
        const checked = normalizeVerificationResult(result(), intent);
        expect(checked.state).toBe('succeeded');
        expect(checked.checks).toEqual([check()]);
        expect(assertAgentResultAccepted(result(), false, intent).state).toBe('succeeded');
    });

    it('rejects «done» without verification (fail-closed)', () => {
        expect(() => assertAgentResultAccepted({}, false, intent)).toThrow();
        expect(() => normalizeVerificationResult({ ...result(), checks: [] })).toThrow();
        expect(() => assertAgentResultAccepted({ ...result(), state: 'succeeded', checks: [] }, false, intent)).toThrow();
    });

    it('allows succeeded only after completed run with all selected checks passed', () => {
        expect(() => normalizeVerificationResult({ ...result(), stage: 'checks' })).toThrow();
        expect(() =>
            normalizeVerificationResult({ ...result(), checks: [check(), check({ state: 'not_run', exitCode: null, signal: null })] }),
        ).toThrow();
        expect(normalizeVerificationResult({ ...result(), checks: [check(), check({ args: ['second.cjs'] })] }).state).toBe(
            'succeeded',
        );
    });

    it('keeps not_run explicit and distinct from failed', () => {
        const notRun = result({
            state: 'failed',
            stage: 'checks',
            checks: [check({ exitCode: null, signal: null, state: 'not_run' })],
            failure: { code: 'EXECUTION_FAILED', action: 'review-result' },
        });
        expect(normalizeVerificationResult(notRun, intent).checks[0].state).toBe('not_run');
        expect(() => normalizeVerificationResult(result({ checks: [check({ state: 'not_run', exitCode: 1 })] }))).toThrow();
        expect(() =>
            normalizeVerificationResult(
                result({
                    state: 'failed',
                    checks: [check({ exitCode: null, signal: null, state: 'not_run' })],
                    failure: { code: 'CHECK_FAILED', action: 'review-result' },
                }),
            ),
        ).not.toThrow();
    });

    it('records a non-zero exit as failed check', () => {
        const failed = result({
            state: 'failed',
            stage: 'checks',
            checks: [check({ exitCode: 1, state: 'failed' })],
            failure: { code: 'CHECK_FAILED', action: 'review-result' },
        });
        const checked = normalizeVerificationResult(failed, intent);
        expect(checked.state).toBe('failed');
        expect(checked.checks[0].exitCode).toBe(1);
        expect(assertAgentResultAccepted(failed, true, intent).state).toBe('failed');
    });

    it('keeps unknown explicit and never accepted as succeeded', () => {
        const unknown = result({
            state: 'unknown',
            stage: 'execution',
            checks: [check({ exitCode: null, signal: null, state: 'not_run' })],
            failure: { code: 'UNKNOWN_OUTCOME', action: 'inspect-workspace' },
        });
        expect(normalizeVerificationResult(unknown, intent).state).toBe('unknown');
        expect(() => assertAgentResultAccepted(unknown, false, intent)).toThrow();
        expect(assertAgentResultAccepted(unknown, true, intent).state).toBe('unknown');
        expect(() =>
            normalizeVerificationResult(result({ state: 'unknown', checks: [check({ exitCode: null, signal: null, state: 'not_run' })] })),
        ).toThrow();
    });

    it('requires a named failure for every non-succeeded state and validates code/action', () => {
        expect(() => normalizeVerificationResult(result({ state: 'failed' }))).toThrow();
        expect(() =>
            normalizeVerificationResult(result({ failure: { code: 'CHECK_FAILED', action: 'review-result' } })),
        ).toThrow();
        expect(() =>
            normalizeVerificationResult(
                result({
                    state: 'failed',
                    checks: [check({ exitCode: 1, state: 'failed' })],
                    failure: { code: 'NO_SUCH_CODE', action: 'review-result' },
                }),
            ),
        ).toThrow();
        expect(() =>
            normalizeVerificationResult(
                result({
                    state: 'failed',
                    checks: [check({ exitCode: 1, state: 'failed' })],
                    failure: { code: 'CHECK_FAILED', action: 'launch-missile' },
                }),
            ),
        ).toThrow();
    });

    it('binds the result to the declared checks (provenance, NFR-4)', () => {
        const other = normalizeVerificationIntent({
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            checks: [{ command: 'node', args: ['other.cjs'] }],
        });
        expect(() => normalizeVerificationResult(result(), other)).toThrow();
        const digest = verificationIntentDigest(intent);
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
        expect(verificationIntentDigest(intent)).toBe(digest);
        expect(verificationIntentDigest(other)).not.toBe(digest);
    });

    it('does not accept raw stdout, secrets or extra fields in the result', () => {
        expect(() => normalizeVerificationResult({ ...result(), stdout: 'raw output' }, intent)).toThrow();
        expect(() =>
            normalizeVerificationResult({ ...result(), checks: [check({ stdout: 'captured' })] }, intent),
        ).toThrow();
    });

    it('normalizes changes and artifacts with SHA provenance', () => {
        const checked = normalizeVerificationResult(
            result({
                changes: [{ path: 'src/app.ts', beforeSha256: sha('b'), afterSha256: sha('c') }],
                artifacts: [{ path: 'openspec/changes/x/tasks.md', sha256: sha('d') }],
            }),
            intent,
        );
        expect(checked.changes).toEqual([{ path: 'src/app.ts', beforeSha256: sha('b'), afterSha256: sha('c') }]);
        expect(checked.artifacts).toEqual([{ path: 'openspec/changes/x/tasks.md', sha256: sha('d') }]);
        expect(() =>
            normalizeVerificationResult(
                result({ changes: [{ path: 'src/app.ts', beforeSha256: sha('b'), afterSha256: sha('b') }] }),
            ),
        ).toThrow();
    });
});

describe('device method workflow contract consumes the universal semantics', () => {
    it('keeps the accepted succeeded receipt shape', () => {
        const checked = normalizeAgentMethodWorkflowResult(deviceResult(), devicePayload);
        expect(checked.state).toBe('succeeded');
        expect(checked.stage).toBe('completed');
        expect(checked.checks).toEqual([check()]);
    });

    it('accepts needs_setup with a named method failure', () => {
        const checked = normalizeAgentMethodWorkflowResult(
            deviceResult({
                state: 'needs_setup',
                stage: 'prerequisites',
                checks: [check({ exitCode: null, signal: null, state: 'not_run' })],
                failure: { code: 'METHOD_MISSING', action: 'setup-method' },
            }),
            devicePayload,
        );
        expect(checked.state).toBe('needs_setup');
        expect(checked.failure).toEqual({ code: 'METHOD_MISSING', action: 'setup-method' });
    });

    it('rejects succeeded without passing checks and unknown without a failure', () => {
        expect(() => normalizeAgentMethodWorkflowResult(deviceResult({ checks: [] }), devicePayload)).toThrow();
        expect(() =>
            normalizeAgentMethodWorkflowResult(
                deviceResult({ checks: [check({ exitCode: null, signal: null, state: 'not_run' })] }),
                devicePayload,
            ),
        ).toThrow();
        expect(() =>
            normalizeAgentMethodWorkflowResult(
                deviceResult({
                    state: 'unknown',
                    stage: 'execution',
                    checks: [check({ exitCode: null, signal: null, state: 'not_run' })],
                }),
                devicePayload,
            ),
        ).toThrow();
    });

    it('rejects a receipt that describes other checks than the original task', () => {
        expect(() =>
            normalizeAgentMethodWorkflowResult(
                deviceResult({ checks: [check({ args: ['other.cjs'] })] }),
                devicePayload,
            ),
        ).toThrow();
    });

    it('reports real change hashes with provenance', () => {
        const checked = normalizeAgentMethodWorkflowResult(
            deviceResult({
                codeChanged: true,
                changes: [{ path: 'src/app.ts', beforeSha256: sha('b'), afterSha256: sha('c') }],
            }),
            devicePayload,
        );
        expect(checked.codeChanged).toBe(true);
        expect(checked.changes).toEqual([{ path: 'src/app.ts', beforeSha256: sha('b'), afterSha256: sha('c') }]);
    });
});
