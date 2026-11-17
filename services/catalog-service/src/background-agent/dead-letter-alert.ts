/**
 * FR-305 (agt-11, phase B): the dead-letter alert channel (epic 6 entry 13, AD-O6 delivery
 * pattern). A dead-lettered job is an operator-visible condition (NFR-2: no silent stop): the
 * alert is a fixed-classifier record (AD-O8: no raw error text, no payload, no instruction)
 * delivered to the channel the host watchdog already uses — the journal line (stderr → docker
 * log) + the alerts.jsonl append (scripts/production/stack-watchdog.mjs emitAlert pattern).
 *
 * The alertmanager delivery channel itself (alertmanager.yml + host receiver) is the scope of the
 * ep6 entry 13 story (ready-for-dev, not in main): this module writes to the same channel shape,
 * so the entry 13 receiver consumes these alerts without a new scheme. Delivery is best-effort:
 * a channel failure never blocks the job lifecycle (the dead-letter row + error store + security
 * event already make the condition durable and visible).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Named constants (NFR-6: each limit is an enforcement point). */
export const BACKGROUND_AGENT_ALERTS = Object.freeze({
    /** The delivery channel override (host default: the watchdog alerts.jsonl, AD-OP-8). */
    envName: 'NEUROCENTER_ALERTS_FILE',
    defaultAlertFile: '/var/log/neurocenter/alerts.jsonl',
    source: 'background-agent',
    deadLetter: Object.freeze({
        severity: 'critical',
        event: 'dead_letter',
    }),
    /** The alert file mode (the channel is operator-readable, not world-readable). */
    fileMode: 0o600,
});

/** One dead-letter alert: the job digests only (AD-O8 classifiers, never the raw error). */
export interface IDeadLetterAlert {
    /** backgroundAgentDigest of the normalized payload (the idempotency key). */
    requestKey: string;
    /** The admitted task id (uuid). */
    requestId: string;
}

/** The alert channel file (the env override or the host default). */
export function deadLetterAlertFile(): string {
    const env = process.env[BACKGROUND_AGENT_ALERTS.envName];
    return typeof env === 'string' && env.trim() ? env : BACKGROUND_AGENT_ALERTS.defaultAlertFile;
}

/**
 * Deliver the dead-letter alert (best-effort): the journal line first, then the alerts.jsonl
 * append. The record is a fixed classifier + the job digests — AD-O8: no raw error text, no
 * instruction, no payload crosses the channel.
 */
export async function writeDeadLetterAlert(alert: IDeadLetterAlert, now: () => number = Date.now): Promise<void> {
    const record = {
        ts: new Date(now()).toISOString(),
        source: BACKGROUND_AGENT_ALERTS.source,
        severity: BACKGROUND_AGENT_ALERTS.deadLetter.severity,
        service: BACKGROUND_AGENT_ALERTS.source,
        event: BACKGROUND_AGENT_ALERTS.deadLetter.event,
        requestKey: alert.requestKey,
        requestId: alert.requestId,
    };
    try {
        process.stderr.write(`[background-agent] ${record.severity}: ${record.event} ${record.requestId}\n`);
    } catch {
        // the journal channel is dead — the file append below still carries the alert.
    }
    try {
        const file = deadLetterAlertFile();
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, JSON.stringify(record) + '\n', { mode: BACKGROUND_AGENT_ALERTS.fileMode });
    } catch {
        // best-effort by design (ep6 e13: the channel is a delivery point, not a transaction).
    }
}
