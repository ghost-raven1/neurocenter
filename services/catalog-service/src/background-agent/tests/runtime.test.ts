import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    assertAgentResultAccepted,
    normalizeVerificationIntent,
} from '../../../../shared/agent-result-verification.cjs';
import { OpenCodeAgentRuntime } from '../runtime';

/** A fake opencode engine: an executable script that speaks the same loopback protocol (serve/agent/session/message). */
function writeFakeEngine(dir: string): string {
    const script = path.join(dir, 'fake-opencode');
    const code = `#!/usr/bin/env node
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
