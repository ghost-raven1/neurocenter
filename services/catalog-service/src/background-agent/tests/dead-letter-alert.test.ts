/**
 * FR-305 (agt-11, phase B): the dead-letter alert channel (epic 6 entry 13, the AD-O6 delivery
 * pattern of scripts/production/stack-watchdog.mjs). The record is a fixed classifier + the job
 * digests only (AD-O8); delivery is best-effort (a channel failure never blocks the job lifecycle).
 */
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_AGENT_ALERTS, deadLetterAlertFile, writeDeadLetterAlert } from '../dead-letter-alert';

const NOW = 1_760_000_000_000;
const REQUEST_ID = '33333333-3333-4333-9333-333333333333';
/** backgroundAgentDigest shape: 64 hex chars (the idempotency key). */
const REQUEST_KEY = 'b'.repeat(64);
const alert = { requestKey: REQUEST_KEY, requestId: REQUEST_ID };

let dir: string;
let file: string;
beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'nc-agt11-dla-'));
    file = path.join(dir, 'alerts.jsonl');
    process.env[BACKGROUND_AGENT_ALERTS.envName] = file;
});
afterEach(async () => {
    delete process.env[BACKGROUND_AGENT_ALERTS.envName];
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
});

describe('dead-letter alert channel (FR-305 agt-11 phase B: ep6 entry 13, AD-O6 delivery)', () => {
    it('writes the fixed-classifier record + the journal line; the file is 0600', async () => {
        const stderr = vi.spyOn(process.stderr, 'write');
        await writeDeadLetterAlert(alert, () => NOW);
        const lines = (await readFile(file, 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual({
            ts: new Date(NOW).toISOString(),
            source: BACKGROUND_AGENT_ALERTS.source,
            severity: BACKGROUND_AGENT_ALERTS.deadLetter.severity,
            service: BACKGROUND_AGENT_ALERTS.source,
            event: BACKGROUND_AGENT_ALERTS.deadLetter.event,
            requestKey: REQUEST_KEY,
            requestId: REQUEST_ID,
        });
        // The journal line (docker log) carries the same fixed classifiers.
        expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toBe(
            `[background-agent] ${BACKGROUND_AGENT_ALERTS.deadLetter.severity}: ${BACKGROUND_AGENT_ALERTS.deadLetter.event} ${REQUEST_ID}\n`,
        );
        // The channel is operator-readable, not world-readable.
        expect((await stat(file)).mode & 0o777).toBe(BACKGROUND_AGENT_ALERTS.fileMode);
    });

    it('appends (the channel is a journal, not a file): one line per dead-lettered job', async () => {
        vi.spyOn(process.stderr, 'write');
        await writeDeadLetterAlert(alert, () => NOW);
        await writeDeadLetterAlert(
            { requestKey: 'c'.repeat(64), requestId: '44444444-4444-4444-8444-444444444444' },
            () => NOW + 1,
        );
        const lines = (await readFile(file, 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).requestId).toBe(REQUEST_ID);
        expect(JSON.parse(lines[1]).requestId).toBe('44444444-4444-4444-8444-444444444444');
    });

    it('the env override selects the channel; an empty or missing env falls back to the host default', () => {
        expect(deadLetterAlertFile()).toBe(file);
        process.env[BACKGROUND_AGENT_ALERTS.envName] = '   ';
        expect(deadLetterAlertFile()).toBe(BACKGROUND_AGENT_ALERTS.defaultAlertFile);
        delete process.env[BACKGROUND_AGENT_ALERTS.envName];
        expect(deadLetterAlertFile()).toBe(BACKGROUND_AGENT_ALERTS.defaultAlertFile);
    });

    it('best-effort: a dead channel (the path is a directory) never throws; the journal line still fires', async () => {
        process.env[BACKGROUND_AGENT_ALERTS.envName] = dir; // an existing directory → EISDIR
        const stderr = vi.spyOn(process.stderr, 'write');
        await expect(writeDeadLetterAlert(alert, () => NOW)).resolves.toBeUndefined();
        expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('dead_letter');
    });

    it('best-effort: an uncreatable path (a file blocks the directory) never throws', async () => {
        const blocker = path.join(dir, 'blocker');
        await mkdir(blocker); // a FILE where the channel needs a DIRECTORY
        process.env[BACKGROUND_AGENT_ALERTS.envName] = path.join(blocker, 'alerts.jsonl');
        vi.spyOn(process.stderr, 'write');
        await expect(writeDeadLetterAlert(alert, () => NOW)).resolves.toBeUndefined();
    });
});
