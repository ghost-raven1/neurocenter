import type {LearningExperience} from './types';

export interface ObservationMetadata {observerVersion: 1; observedAt: string; sessionEvent: 'idle' | 'error'; toolObservations: Record<string, number>; calls: number; truncated: boolean; elapsedMs: number}
const tools = new Set(['read', 'edit', 'write', 'bash', 'glob', 'grep', 'list', 'task', 'todowrite', 'todoread', 'webfetch', 'websearch', 'lsp', 'skill', 'question', 'apply_patch']);
const bounded = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** Only the exact device collector v1 envelope receives a human-readable interpretation. */
export function observationMetadata(origin: LearningExperience['origin'], evidence: LearningExperience['evidence'][number]): ObservationMetadata | null {
    if (origin !== 'device' || evidence.kind !== 'observation' || evidence.status !== 'unknown' || !/^opencode-session-sha256:[a-f0-9]{64}$/.test(evidence.reference ?? '')) return null;
    try {
        const value = JSON.parse(evidence.summary) as ObservationMetadata;
        if (!value || value.observerVersion !== 1 || !['idle', 'error'].includes(value.sessionEvent) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.truncated !== 'boolean'
            || !bounded(value.calls, 10000) || !bounded(value.elapsedMs, 86_400_000) || !value.toolObservations || typeof value.toolObservations !== 'object' || Array.isArray(value.toolObservations)) return null;
        const entries = Object.entries(value.toolObservations);
        if (entries.some(([name, count]) => !tools.has(name) || !bounded(count, 10000) || !count) || entries.reduce((sum, [, count]) => sum + count, 0) !== value.calls) return null;
        return value;
    } catch {return null;}
}
