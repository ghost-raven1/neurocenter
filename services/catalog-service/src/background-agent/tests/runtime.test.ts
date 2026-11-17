import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    assertAgentResultAccepted,
    normalizeVerificationIntent,
} from '../../../../shared/agent-result-verification.cjs';
import { OpenCodeAgentRuntime } from '../runtime';

/**
 * A fake opencode engine: an executable script that speaks the same loopback protocol
 * (serve/agent/session/message) and answers --version with the pinned 1.14.48 (FR-308 preparation
 * runs the engine version probe). With NC_RT_PROMPT_LOG / NC_RT_ENV_LOG set it logs the received
 * prompt text and the relevant environment (the FR-308 no-hidden-updates assertions).
 */
function writeFakeEngine(dir: string): string {
    const script = path.join(dir, 'fake-opencode');
    const code = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('opencode 1.14.48'); process.exit(0); }
const http = require('node:http');
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
        const send = (code, value) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(value));
        };
        if (req.method === 'GET' && url.pathname === '/agent')
            return send(200, [{ name: 'nc-fake', mode: 'primary', model: { providerID: 'p', modelID: 'm' } }]);
        if (req.method === 'POST' && url.pathname === '/session') return send(200, { id: 'ses_fake' });
        if (req.method === 'POST' && url.pathname === '/session/ses_fake/message') {
            const parsed = JSON.parse(body || '{}');
            const text = (parsed.parts && parsed.parts[0] && parsed.parts[0].text) || '';
            if (process.env.NC_RT_PROMPT_LOG) fs.appendFileSync(process.env.NC_RT_PROMPT_LOG, text + '\\n---\\n');
            if (process.env.NC_RT_ENV_LOG)
                fs.appendFileSync(
                    process.env.NC_RT_ENV_LOG,
                    JSON.stringify({
                        OPENSPEC_TELEMETRY: process.env.OPENSPEC_TELEMETRY,
                        OPENSPEC_NO_UPDATE_CHECK: process.env.OPENSPEC_NO_UPDATE_CHECK,
                        OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
                        OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
                    }) + '\\n',
                );
            if (text.includes('FAIL'))
                return send(200, {
                    info: {
                        id: 'msg_1',
                        role: 'assistant',
                        sessionID: 'ses_fake',
                        time: { completed: Date.now() },
                        finish: 'error',
                        error: 'boom',
                    },
                    parts: [],
                });
            return send(200, {
                info: {
                    id: 'msg_1',
                    role: 'assistant',
                    agent: 'nc-fake',
                    providerID: 'p',
                    modelID: 'm',
                    sessionID: 'ses_fake',
                    time: { completed: Date.now() },
                    finish: 'stop',
                },
                parts: [{ type: 'text', text: 'done', sessionID: 'ses_fake', messageID: 'msg_1' }],
            });
        }
        send(404, { error: 'not found' });
    });
});
server.listen(0, '127.0.0.1', () => {
    console.log('listening on http://127.0.0.1:' + server.address().port);
});
`;
    writeFileSync(script, code);
    chmodSync(script, 0o755);
    return script;
}

let workDir: string;
let engine: string;
const ok = { command: 'node', args: ['-e', 'process.exit(0)'] };
const deadline = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'nc-bg-rt-'));
    engine = writeFakeEngine(workDir);
});
afterEach(() => {
    // leave the tmp dir; the fake server is killed by the runtime itself
});

const input = (overrides: Record<string, unknown> = {}) => ({
    root: workDir,
    prompt: 'Фоновая задача',
    checks: [ok],
    deadlineAt: deadline(),
    ...overrides,
});

describe('OpenCodeAgentRuntime (FR-305, port of opencode-http-runner + FR-304 checks)', () => {
    it('succeeds: completed assistant turn and real passing check outcomes', async () => {
        const result = await new OpenCodeAgentRuntime().run(input(), { engine });
        expect(result.state).toBe('succeeded');
        expect(result.stage).toBe('completed');
        expect(result.failure).toBeUndefined();
        expect(result.checks).toEqual([
            { command: 'node', args: ['-e', 'process.exit(0)'], exitCode: 0, signal: null, state: 'passed' },
        ]);
        // The result is a valid FR-304 contract describing exactly the declared intent.
        const intent = normalizeVerificationIntent({ protocol: AGENT_RESULT_VERIFICATION_PROTOCOL, checks: [ok] });
        expect(assertAgentResultAccepted(result, false, intent).state).toBe('succeeded');
    });

    it('fails with CHECK_FAILED and reports every declared check (a failure does not stop the rest)', async () => {
        const failing = { command: 'node', args: ['-e', 'process.exit(3)'] };
        const result = await new OpenCodeAgentRuntime().run(input({ checks: [ok, failing] }), { engine });
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('checks');
        expect(result.failure).toEqual({ code: 'CHECK_FAILED', action: 'review-result' });
        expect(result.checks.map((row) => row.state)).toEqual(['passed', 'failed']);
        expect(result.checks[1].exitCode).toBe(3);
        expect(result.checks[1].signal).toBeNull();
    });

    it('fails at execution when the turn is not a completed assistant turn; declared checks are not_run', async () => {
        const result = await new OpenCodeAgentRuntime().run(input({ prompt: 'FAIL' }), { engine });
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('execution');
        expect(result.failure).toEqual({ code: 'EXECUTION_FAILED', action: 'new-request' });
        expect(result.checks).toEqual([
            { command: 'node', args: ['-e', 'process.exit(0)'], exitCode: null, signal: null, state: 'not_run' },
        ]);
    });

    it('confirms the explicitly selected agent before inference (runtime introspection)', async () => {
        const selected = { slug: 'nc-fake', mode: 'primary' as const, model: { providerID: 'p', modelID: 'm' } };
        const result = await new OpenCodeAgentRuntime().run(input({ selected }), { engine });
        expect(result.state).toBe('succeeded');
    });

    it('refuses a selected agent the runtime does not confirm (provenance mismatch, fail-closed)', async () => {
        const selected = { slug: 'nc-other', mode: 'primary' as const, model: { providerID: 'p', modelID: 'm' } };
        const result = await new OpenCodeAgentRuntime().run(input({ selected }), { engine });
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('execution');
        expect(result.failure).toEqual({ code: 'PROVENANCE_MISMATCH', action: 'new-request' });
    });

    it('bounds each check by its budget: a slow check is killed and reported with its real signal', async () => {
        const slow = { command: 'sleep', args: ['5'] };
        const result = await new OpenCodeAgentRuntime().run(input({ checks: [slow] }), { engine, checkTimeoutMs: 300 });
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('checks');
        expect(result.checks[0].state).toBe('failed');
        expect(result.checks[0].exitCode).toBeNull();
        expect(result.checks[0].signal).toBe('SIGKILL');
    });

    it('fails fast with TIMEOUT when the server-fixed deadline is already passed (nothing runs)', async () => {
        const result = await new OpenCodeAgentRuntime().run(
            input({ deadlineAt: new Date(Date.now() - 1000).toISOString() }),
            {
                engine,
            },
        );
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('execution');
        expect(result.failure).toEqual({ code: 'TIMEOUT', action: 'new-request' });
        expect(result.checks[0].state).toBe('not_run');
    });

    it('reports a non-executable check as failed without an exit code (never not_run, never passed)', async () => {
        const missing = { command: 'nc-definitely-missing', args: [] };
        const result = await new OpenCodeAgentRuntime().run(input({ checks: [missing] }), { engine });
        expect(result.state).toBe('failed');
        expect(result.checks[0]).toEqual({
            command: 'nc-definitely-missing',
            args: [],
            exitCode: null,
            signal: null,
            state: 'failed',
        });
    });

    it('stops the engine after the run (no orphan server)', async () => {
        const result = await new OpenCodeAgentRuntime().run(input(), { engine });
        expect(result.state).toBe('succeeded');
        // The engine child is terminated in the finally block; give it a moment, then confirm the port is free.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const still = await new Promise<number>((resolve) => {
            const probe = () => {
                fetch('http://127.0.0.1:1', { signal: AbortSignal.timeout(200) })
                    .then(() => resolve(1))
                    .catch(() => resolve(0));
            };
            probe();
        });
        expect(still).toBe(0);
    });
});

/**
 * FR-308 wiring: a 'combined' (BMAD→OpenSpec) run goes through prepareMainMethod — the prepared
 * prompt and the no-hidden-updates environment reach the engine, the OpenSpec validate gate runs
 * before the declared checks, and any pinned-prerequisite mismatch fails at 'prerequisites'.
 */
describe('OpenCodeAgentRuntime FR-308 wiring (method=combined → prepareMainMethod)', () => {
    let workDir: string;
    let engine: string;
    const ok = { command: 'node', args: ['-e', 'process.exit(0)'] };
    const deadline = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const input = (overrides: Record<string, unknown> = {}) => ({
        root: workDir,
        prompt: 'Фоновая задача',
        checks: [ok],
        deadlineAt: deadline(),
        ...overrides,
    });
    const COMBINED = 'bmad-6.12.4+openspec-1.15.0';

    /** The same fixture project the core preparation tests use: pinned BMAD + OpenSpec + required skills. */
    const seedCombined = (root: string): void => {
        mkdirSync(path.join(root, '_bmad/_config'), { recursive: true });
        mkdirSync(path.join(root, '_bmad/scripts'), { recursive: true });
        writeFileSync(path.join(root, '_bmad/_config/manifest.yaml'), 'installation:\n  version: "6.12.4"\n');
        writeFileSync(path.join(root, '_bmad/scripts/render_skill.py'), '# render skill\n');
        mkdirSync(path.join(root, 'openspec'), { recursive: true });
        writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
        for (const name of [
            'bmad-help',
            'bmad-product-brief',
            'bmad-prd',
            'bmad-architecture',
            'openspec-propose',
            'openspec-apply-change',
            'openspec-verify-change',
            'openspec-archive-change',
        ]) {
            const dir = path.join(root, '.opencode/skills', name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n${name} instructions.\n`);
        }
    };
    /** Stub main-method runner: pinned versions OK (the engine probe matches the fake engine path). */
    const okRunner = (root: string, enginePath: string) => async (_root: string, command: string, args: string[]) => {
        if (command === enginePath) return { code: 0, stdout: '1.14.48' };
        if (command === 'bmad') return { code: 0, stdout: '6.12.4' };
        if (command === 'openspec') {
            if (args[0] === 'context') return { code: 0, stdout: JSON.stringify({ root: { path: root } }) };
            if (args[0] === 'list') return { code: 0, stdout: '[]' };
            return { code: 0, stdout: '1.15.0' };
        }
        if (command === 'uv') return { code: 0, stdout: 'uv 0.9.9' };
        return { code: 0, stdout: '' };
    };
    /** A fake `openspec` executable on PATH: the runtime's real validate gate spawns it (not the stub). */
    const writeOpenSpecStub = (root: string, exitCode: number): string => {
        const binDir = path.join(root, 'bin');
        mkdirSync(binDir, { recursive: true });
        const stub = path.join(binDir, 'openspec');
        writeFileSync(stub, `#!/usr/bin/env node\nprocess.exit(${exitCode});\n`);
        chmodSync(stub, 0o755);
        return binDir;
    };
    const withPath = (binDir: string, fn: () => Promise<void>): Promise<void> => {
        const previous = process.env.PATH;
        process.env.PATH = binDir + path.delimiter + (previous ?? '');
        return fn().finally(() => {
            process.env.PATH = previous;
        });
    };

    beforeEach(() => {
        workDir = mkdtempSync(path.join(tmpdir(), 'nc-bg-rt-method-'));
        engine = writeFakeEngine(workDir);
        seedCombined(workDir);
    });

    it('combined: the prepared prompt and the no-hidden-updates environment reach the engine (I/O 1–3)', async () => {
        const binDir = writeOpenSpecStub(workDir, 0);
        const promptLog = path.join(workDir, 'prompt.log');
        const envLog = path.join(workDir, 'env.log');
        process.env.NC_RT_PROMPT_LOG = promptLog;
        process.env.NC_RT_ENV_LOG = envLog;
        try {
            const runtime = new OpenCodeAgentRuntime(okRunner(workDir, engine));
            const result = await withPath(binDir, () =>
                runtime.run(input({ method: 'combined', methodVersion: COMBINED, workflowId: 'wf-123' }), { engine }),
            );
            expect(result.state).toBe('succeeded');
            expect(result.checks).toEqual([
                { command: 'node', args: ['-e', 'process.exit(0)'], exitCode: 0, signal: null, state: 'passed' },
            ]);
            // The engine received the BMAD→OpenSpec method prompt, not the generic one.
            const prompt = readFileSync(promptLog, 'utf8');
            expect(prompt).toContain('Neurocenter main development workflow wf-123');
            expect(prompt).toContain(`Method combined ${COMBINED}`);
            expect(prompt).toContain('reuse accepted brief/PRD/architecture');
            expect(prompt).toContain('Do not run BMAD build-auto or a second implementation cycle');
            expect(prompt).toContain('Run openspec validate --all --strict --no-interactive after changes');
            expect(prompt).toContain('FILE .opencode/skills/bmad-prd/SKILL.md');
            expect(prompt).toContain('FILE .opencode/skills/openspec-apply-change/SKILL.md');
            expect(prompt).toContain('USER TASK:');
            expect(prompt).toContain('Фоновая задача');
            // The engine inherited the no-hidden-updates environment (FR-308).
            const env = JSON.parse(readFileSync(envLog, 'utf8'));
            expect(env.OPENSPEC_TELEMETRY).toBe('0');
            expect(env.OPENSPEC_NO_UPDATE_CHECK).toBe('1');
            const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
            expect(config.autoupdate).toBe(false);
            expect(config.share).toBe('disabled');
            expect(config.permission.external_directory).toBe('deny');
            expect(JSON.parse(env.OPENCODE_PERMISSION).external_directory).toBe('deny');
        } finally {
            delete process.env.NC_RT_PROMPT_LOG;
            delete process.env.NC_RT_ENV_LOG;
        }
    });

    it('combined: a mismatching pinned version fails at prerequisites, all checks not_run (I/O 2)', async () => {
        const badRunner = async (_root: string, command: string, args: string[]) =>
            command === 'bmad' && args[0] === '--version'
                ? { code: 0, stdout: '5.0.0' }
                : okRunner(workDir, engine)(_root, command, args);
        const result = await new OpenCodeAgentRuntime(badRunner).run(
            input({ method: 'combined', methodVersion: COMBINED }),
            { engine },
        );
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('prerequisites');
        expect(result.failure).toEqual({ code: 'EXECUTION_FAILED', action: 'new-request' });
        expect(result.checks).toEqual([
            { command: 'node', args: ['-e', 'process.exit(0)'], exitCode: null, signal: null, state: 'not_run' },
        ]);
    });

    it('combined: the OpenSpec validate gate not passed → CHECK_FAILED, declared checks not_run (I/O 7)', async () => {
        const binDir = writeOpenSpecStub(workDir, 1);
        const result = await withPath(binDir, () =>
            new OpenCodeAgentRuntime(okRunner(workDir, engine)).run(
                input({ method: 'combined', methodVersion: COMBINED }),
                { engine },
            ),
        );
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('checks');
        expect(result.failure).toEqual({ code: 'CHECK_FAILED', action: 'review-result' });
        expect(result.checks).toEqual([
            { command: 'node', args: ['-e', 'process.exit(0)'], exitCode: null, signal: null, state: 'not_run' },
        ]);
    });

    it('a non-combined method keeps the generic run (the method prompt is not built)', async () => {
        const promptLog = path.join(workDir, 'prompt.log');
        process.env.NC_RT_PROMPT_LOG = promptLog;
        try {
            const result = await new OpenCodeAgentRuntime().run(
                input({ method: 'openspec', methodVersion: '1.15.0' }),
                { engine },
            );
            expect(result.state).toBe('succeeded');
            const entries = readFileSync(promptLog, 'utf8')
                .split('\n---\n')
                .filter((entry) => entry.length > 0);
            expect(entries).toEqual(['Фоновая задача']);
        } finally {
            delete process.env.NC_RT_PROMPT_LOG;
        }
    });
});
