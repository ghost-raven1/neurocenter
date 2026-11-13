import { normalizeBackgroundAgentPayload, type IBackgroundAgentPayload } from '../../../shared/background-agent.cjs';
import {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    assertAgentResultAccepted,
    normalizeVerificationIntent,
} from '../../../shared/agent-result-verification.cjs';
import type { IAgentRuntime, IRuntimeResult } from './runtime';
import { TaskContext } from './context';

/**
 * FR-305 background-agent worker: the reusable core. Admission normalizes and pins the immutable
 * task (server-fixed method version, declared checks, deadline); the run is asynchronous and never
 * blocks the chat; acceptance is fail-closed through the FR-304 universal verification gate.
 *
 * Extension seams: the job store (in-memory here; the lease/pg implementation lands with the compose
 * service, phase B per 1.12 D2) and the result sink (chat-origin publication, wired in phase B).
 * The runtime and context providers are injected, not constructed — entry 10/11 decorate the
 * runtime, new context sources plug in as providers.
 */
export interface IBackgroundAgentStore {
    /** Idempotent by the payload digest: a repeated request for the same normalized task is a no-op. */
    admit(payload: IBackgroundAgentPayload): Promise<void>;
    claim(requestId: string): Promise<IBackgroundAgentPayload | undefined>;
    complete(requestId: string, result: IRuntimeResult): Promise<void>;
}

/** Result delivery seam: chat-origin publication (project_chat_method_workflows pattern, phase B). */
export interface IResultSink {
    deliver(requestId: string, result: IRuntimeResult): Promise<void>;
}

export interface IWorkerDeps {
    store: IBackgroundAgentStore;
    runtime: IAgentRuntime;
    context?: TaskContext;
    sink?: IResultSink;
    renderPrompt?: (instruction: string, rendered: string[]) => string;
}

/** An admitted task whose outcome was not acknowledged: the job is never silently lost. */
export class BackgroundWorkerError extends Error {}

export class BackgroundAgentWorker {
    private readonly store: IBackgroundAgentStore;
    private readonly runtime: IAgentRuntime;
    private readonly context: TaskContext;
    private readonly sink?: IResultSink;
    private readonly renderPrompt: (instruction: string, rendered: string[]) => string;

    constructor(deps: IWorkerDeps) {
        this.store = deps.store;
        this.runtime = deps.runtime;
        this.context = deps.context ?? TaskContext.defaults();
        this.sink = deps.sink;
        this.renderPrompt =
            deps.renderPrompt ??
            ((instruction, rendered) =>
                rendered.length ? `${instruction}\n\nTask context:\n${rendered.join('\n')}` : instruction);
    }

    /** Admission: normalize (server-fixed fields, declared checks); the store pins the digest (idempotent). */
    async admit(value: unknown): Promise<IBackgroundAgentPayload> {
        const payload = normalizeBackgroundAgentPayload(value);
        await this.store.admit(payload);
        return payload;
    }

    /**
     * Process one admitted task: claim → context → runtime → fail-closed acceptance → delivery.
     * Runs in the background (the chat request that admitted the task already returned); the result
     * is delivered to the sink and recorded in the store. Errors are reported as an explicit
     * `unknown`/failed outcome where the contract allows, never swallowed.
     */
    async process(requestId: string): Promise<IRuntimeResult> {
        const payload = await this.store.claim(requestId);
        if (!payload) throw new BackgroundWorkerError(`Фоновая задача ${requestId} не найдена или уже завершена.`);
        const checked = normalizeBackgroundAgentPayload(payload);
        const intent = normalizeVerificationIntent({
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            checks: checked.checks,
        });
        let result: IRuntimeResult;
        try {
            const { descriptors, root } = await this.context.prepare(checked.projectId, checked.context);
            result = await this.runtime.run(
                {
                    root,
                    prompt: this.renderPrompt(
                        checked.instruction,
                        descriptors.map((descriptor) => descriptor.rendered),
                    ),
                    checks: checked.checks,
                    deadlineAt: checked.deadlineAt,
                },
                {},
            );
        } catch {
            // Context resolution is a prerequisite failure: the task is failed before execution,
            // with every declared check explicitly not_run (FR-304: not_run is distinct from failed).
            result = {
                protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
                state: 'failed',
                stage: 'prerequisites',
                checks: checked.checks.map((check) => ({
                    command: check.command,
                    args: [...check.args],
                    exitCode: null,
                    signal: null,
                    state: 'not_run' as const,
                })),
                failure: { code: 'EXECUTION_FAILED', action: 'new-request' },
            };
        }
        // Fail-closed acceptance (FR-304): «done» without verification is not accepted. The outcome
        // must be a verified result matching the acknowledged state, describing exactly the intent.
        assertAgentResultAccepted(result, result.state !== 'succeeded', intent);
        await this.store.complete(requestId, result);
        await this.sink?.deliver(requestId, result);
        return result;
    }
}
