import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { IBackgroundAgentCheck } from '../../../shared/background-agent.cjs';
import {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    VERIFICATION_FAILURE_ACTIONS,
    VERIFICATION_FAILURE_CODES,
} from '../../../shared/agent-result-verification.cjs';

/**
 * FR-305 runtime seam: runs a background task in `root` and produces the universal verified result
 * (FR-304 contract, agent-result-verification-v1). The OpenCode runtime below is the default
 * implementation, ported from the device opencode-http-runner (serve → loopback → Basic-auth →
 * denied question/plan → completed assistant turn → declared checks). Future entries decorate this
 * interface, not the implementation: entry 10 (BMAD→OpenSpec main runtime) and entry 11
 * (crash-resilience wrapper) are injected as IAgentRuntime implementations.
 *
 * Only fixed metadata and real check outcomes leave this module: model text, tools, server logs
 * and credentials stay private (FR-304: raw stdout/секреты не передаются).
 */
export type TVerificationFailureCode = (typeof VERIFICATION_FAILURE_CODES)[number];
export type TVerificationFailureAction = (typeof VERIFICATION_FAILURE_ACTIONS)[number];

/** One observed check outcome (FR-304 contract row): real exit code/signal; not_run carries no exit. */
export interface IRuntimeCheckOutcome {
    command: string;
    args: string[];
    exitCode: number | null;
    signal: string | null;
    state: 'passed' | 'failed' | 'not_run';
}

/** The universal verified result the worker accepts (FR-304). */
export interface IRuntimeResult {
    protocol: typeof AGENT_RESULT_VERIFICATION_PROTOCOL;
    state: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    stage: 'prerequisites' | 'execution' | 'checks' | 'completed';
    checks: IRuntimeCheckOutcome[];
    failure?: { code: TVerificationFailureCode; action: TVerificationFailureAction };
}

/** An explicitly selected agent (the agt-08 per-agent extension set flows through this seam). */
export interface ISelectedRuntimeAgent {
    slug: string;
    mode: 'primary' | 'all';
    model: { providerID: string; modelID: string };
}

export interface IRuntimeInput {
    /** Absolute working directory of the task (the project folder). */
    root: string;
    /** The instruction plus rendered task context. */
    prompt: string;
    /** The declared verification intent (FR-304): the result must describe exactly these checks. */
    checks: IBackgroundAgentCheck[];
    /** ISO deadline fixed by the server; the whole run (turn + checks) must finish before it. */
    deadlineAt: string;
    /** Optional explicitly selected agent; the runtime introspection must confirm it before inference. */
    selected?: ISelectedRuntimeAgent;
}

export interface IAgentRuntimeOptions {
    /** Path to the opencode engine binary (default: resolved from PATH). Injectable for tests. */
    engine?: string;
    /** Per-check time budget (default: 5 minutes). */
    checkTimeoutMs?: number;
    /** Engine startup budget (default: 15 seconds). */
    startupTimeoutMs?: number;
}

export interface IAgentRuntime {
    run(input: IRuntimeInput, options?: IAgentRuntimeOptions): Promise<IRuntimeResult>;
}

const OUTPUT_LIMIT = 1024 * 1024;
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
type TRuntimeFailureCode = 'EXECUTION_FAILED' | 'OUTPUT_LIMIT' | 'TIMEOUT' | 'SELECTED_AGENT_NOT_READY';
class RuntimeFailure extends Error {
    code: TRuntimeFailureCode;
    constructor(code: TRuntimeFailureCode = 'EXECUTION_FAILED') {
        super(code);
        this.code = code;
    }
}
/** A runtime failure names the FR-304 failure the result must carry (universal codes, NFR-4). */
const FAILURE: Record<TRuntimeFailureCode, { code: TVerificationFailureCode; action: TVerificationFailureAction }> = {
    EXECUTION_FAILED: { code: 'EXECUTION_FAILED', action: 'new-request' },
    SELECTED_AGENT_NOT_READY: { code: 'PROVENANCE_MISMATCH', action: 'new-request' },
    TIMEOUT: { code: 'TIMEOUT', action: 'new-request' },
    OUTPUT_LIMIT: { code: 'OUTPUT_LIMIT', action: 'inspect-workspace' },
};
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Runtime introspection must resolve the explicitly selected primary agent and its compiled model before any inference. */
export function assertRuntimeAgent(value: unknown, selected: ISelectedRuntimeAgent): void {
    if (!Array.isArray(value)) throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
    const matches = value.filter((agent) => object(agent) && agent.name === selected.slug);
    const agent = matches[0];
    if (
        matches.length !== 1 ||
        !object(agent) ||
        agent.mode !== selected.mode ||
        !object(agent.model) ||
        (agent.model as Record<string, unknown>).providerID !== selected.model.providerID ||
        (agent.model as Record<string, unknown>).modelID !== selected.model.modelID
    )
        throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
}

/** A successful HTTP response must contain the final completed assistant turn, not a tool-call or partial response. */
export function assertCompletedAssistant(value: unknown, session: string, selected?: ISelectedRuntimeAgent): void {
    if (!object(value) || !object(value.info) || !Array.isArray(value.parts)) throw new RuntimeFailure();
    const info = value.info;
    if (
        selected &&
        (info.agent !== selected.slug ||
            info.providerID !== selected.model.providerID ||
            info.modelID !== selected.model.modelID)
    )
        throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
    if (
        info.role !== 'assistant' ||
        info.sessionID !== session ||
        !object(info.time) ||
        !finite(info.time.completed) ||
        info.error !== undefined ||
        info.finish !== 'stop'
    )
        throw new RuntimeFailure();
    if (
        !value.parts.some(
            (part) => object(part) && part.type === 'text' && typeof part.text === 'string' && part.text.trim(),
        )
    )
        throw new RuntimeFailure();
    for (const part of value.parts) {
        if (!object(part) || part.sessionID !== session || part.messageID !== info.id) throw new RuntimeFailure();
        if (part.type === 'tool' && (!object(part.state) || part.state.status !== 'completed'))
            throw new RuntimeFailure();
        if (part.type === 'step-finish' && part.reason !== 'stop') throw new RuntimeFailure();
    }
}

async function boundedJson(response: Response): Promise<unknown> {
    if (!response.ok || !response.body) throw new RuntimeFailure();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > OUTPUT_LIMIT) throw new RuntimeFailure('OUTPUT_LIMIT');
            chunks.push(next.value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
        await reader.cancel().catch(() => {});
    }
}

function notRun(check: IBackgroundAgentCheck): IRuntimeCheckOutcome {
    return { command: check.command, args: [...check.args], exitCode: null, signal: null, state: 'not_run' };
}
const outcome = (
    check: IBackgroundAgentCheck,
    exitCode: number | null,
    signal: string | null,
): IRuntimeCheckOutcome => ({
    command: check.command,
    args: [...check.args],
    exitCode,
    signal,
    state: exitCode === 0 && signal === null ? 'passed' : 'failed',
});

/** Run one declared check in root with a bounded budget; stdout/stderr are dropped (never cross the wire). */
function runCheck(root: string, check: IBackgroundAgentCheck, budgetMs: number): Promise<IRuntimeCheckOutcome> {
    return new Promise((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn(check.command, check.args, { cwd: root, stdio: 'ignore' });
        } catch {
            resolve({ command: check.command, args: [...check.args], exitCode: null, signal: null, state: 'failed' });
            return;
        }
        const kill = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, budgetMs);
        child.once('error', () => {
            clearTimeout(kill);
            resolve({ command: check.command, args: [...check.args], exitCode: null, signal: null, state: 'failed' });
        });
        child.once('close', (exitCode, signal) => {
            clearTimeout(kill);
            resolve(outcome(check, exitCode, signal));
        });
    });
}

/** All declared checks run in order (a failure does not stop the rest — every declared check is reported). */
async function runChecks(
    root: string,
    checks: IBackgroundAgentCheck[],
    deadline: number,
    checkTimeoutMs: number,
): Promise<{ outcomes: IRuntimeCheckOutcome[]; deadlineExceeded: boolean }> {
    const outcomes: IRuntimeCheckOutcome[] = [];
    let deadlineExceeded = false;
    for (const check of checks) {
        if (!deadlineExceeded && (Number.isFinite(deadline) ? Date.now() >= deadline : false)) {
            deadlineExceeded = true;
            outcomes.push(notRun(check));
            continue;
        }
        if (deadlineExceeded) {
            outcomes.push(notRun(check));
            continue;
        }
        const budget = Number.isFinite(deadline) ? Math.min(checkTimeoutMs, deadline - Date.now()) : checkTimeoutMs;
        outcomes.push(await runCheck(root, check, Math.max(budget, 1)));
    }
    return { outcomes, deadlineExceeded };
}

/**
 * The default runtime (FR-305): drives a private opencode server on loopback for one completed
 * assistant turn, then executes the declared checks in root and reports their real outcomes.
 */
export class OpenCodeAgentRuntime implements IAgentRuntime {
    async run(input: IRuntimeInput, options: IAgentRuntimeOptions = {}): Promise<IRuntimeResult> {
        const deadline = Date.parse(input.deadlineAt);
        if (!Number.isFinite(deadline) || deadline <= Date.now())
            return {
                protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
                state: 'failed',
                stage: 'execution',
                checks: input.checks.map(notRun),
                failure: FAILURE.TIMEOUT,
            };
        try {
            await this.runTurn(input, options);
        } catch (error) {
            const code: TRuntimeFailureCode = error instanceof RuntimeFailure ? error.code : 'EXECUTION_FAILED';
            return {
                protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
                state: 'failed',
                stage: 'execution',
                checks: input.checks.map(notRun),
                failure: FAILURE[code],
            };
        }
        const { outcomes, deadlineExceeded } = await runChecks(
            input.root,
            input.checks,
            deadline,
            options.checkTimeoutMs ?? 5 * 60 * 1000,
        );
        if (deadlineExceeded)
            return {
                protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
                state: 'failed',
                stage: 'checks',
                checks: outcomes,
                failure: FAILURE.TIMEOUT,
            };
        if (outcomes.some((row) => row.state === 'failed'))
            return {
                protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
                state: 'failed',
                stage: 'checks',
                checks: outcomes,
                failure: { code: 'CHECK_FAILED', action: 'review-result' },
            };
        return {
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            state: 'succeeded',
            stage: 'completed',
            checks: outcomes,
        };
    }

    /** serve → loopback → Basic-auth → (selected-agent introspection) → denied question/plan → completed turn. */
    private async runTurn(input: IRuntimeInput, options: IAgentRuntimeOptions): Promise<void> {
        const engine = options.engine ?? 'opencode';
        const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
        const turnBudget = Math.min(TURN_TIMEOUT_MS, Date.parse(input.deadlineAt) - Date.now());
        const controller = new AbortController();
        const password = randomBytes(32).toString('hex');
        const username = 'neurocenter-background';
        const timer = setTimeout(() => controller.abort(new RuntimeFailure('TIMEOUT')), turnBudget);
        const abort = () => controller.abort(new RuntimeFailure());
        process.once('SIGTERM', abort);
        process.once('SIGINT', abort);
        const server = spawn(engine, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
            cwd: input.root,
            env: { ...process.env, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
            shell: false,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise<void>((resolve) => server.once('close', () => resolve()));
        let bytes = 0;
        let tail = '';
        const observe = (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > OUTPUT_LIMIT) controller.abort(new RuntimeFailure('OUTPUT_LIMIT'));
            tail = (tail + chunk.toString('utf8')).slice(-8192);
        };
        server.stdout.on('data', observe);
        server.stderr.on('data', observe);
        const failed = () => controller.abort(new RuntimeFailure());
        server.once('error', failed);
        server.once('exit', failed);
        try {
            const url = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => finish(new RuntimeFailure('TIMEOUT')), startupTimeoutMs);
                const ready = () => {
                    const match = tail.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
                    if (match) finish(undefined, match[1]);
                };
                const cancelled = () => finish(controller.signal.reason);
                const finish = (error?: unknown, value?: string) => {
                    clearTimeout(timeout);
                    if (error) reject(error);
                    else resolve(value!);
                };
                server.stdout.on('data', ready);
                server.stderr.on('data', ready);
                controller.signal.addEventListener('abort', cancelled, { once: true });
                if (controller.signal.aborted) cancelled();
                else ready();
            });
            const request = async (method: 'GET' | 'POST', route: string, value?: unknown) => {
                const target = new URL(route, url);
                target.searchParams.set('directory', input.root);
                return boundedJson(
                    await fetch(target, {
                        method,
                        redirect: 'error',
                        signal: controller.signal,
                        headers: {
                            'content-type': 'application/json',
                            authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
                        },
                        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
                    }),
                );
            };
            if (input.selected) assertRuntimeAgent(await request('GET', '/agent'), input.selected);
            const permission = ['question', 'plan_enter', 'plan_exit'].map((permission) => ({
                permission,
                action: 'deny',
                pattern: '*',
            }));
            const session = await request('POST', '/session', {
                title: 'Neurocenter background workflow',
                permission,
            });
            if (!object(session) || typeof session.id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(session.id))
                throw new RuntimeFailure();
            const response = await request('POST', `/session/${session.id}/message`, {
                ...(input.selected ? { agent: input.selected.slug, model: input.selected.model } : {}),
                parts: [{ type: 'text', text: input.prompt }],
            });
            assertCompletedAssistant(response, session.id, input.selected);
            controller.signal.throwIfAborted();
        } finally {
            clearTimeout(timer);
            process.off('SIGTERM', abort);
            process.off('SIGINT', abort);
            server.off('exit', failed);
            if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
            const kill = setTimeout(() => server.kill('SIGKILL'), 1000);
            try {
                await exited;
            } finally {
                clearTimeout(kill);
            }
        }
    }
}
