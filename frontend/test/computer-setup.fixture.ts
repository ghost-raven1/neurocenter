import {createHash} from 'node:crypto';
import {vi} from 'vitest';
import type {CliObservationApi} from '../src/features/ComputerSetup/api';
import {createCliObservationController} from '../src/features/ComputerSetup/controller';
import {initialCliObservation, type CliIntent} from '../src/features/ComputerSetup/model';
import type {CliJournalLock} from '../src/features/ComputerSetup/journalLock';

export const email = 'owner@example.test', role = 'Наблюдатель';
export const deviceId = 'a1111111-1111-4111-8111-111111111111', jobId = 'b2222222-2222-4222-8222-222222222222', requestKey = 'c3333333-3333-4333-8333-333333333333';
export const at = '2026-10-28T00:00:00.000Z';
export const request = {deviceId, kind: 'inspect-opencode-cli' as const, scope: 'global' as const, requestKey};
export const intent: CliIntent = {version: 1, email, role, request};
export const job = (changes: Record<string, unknown> = {}) => ({id: jobId, deviceId, kind: request.kind, projectId: null, state: 'queued', createdAt: at, updatedAt: at, result: null, ...changes});
export const observed = (status = 'installed') => ({schemaVersion: 1, scope: 'global', deviceId, jobId, checkedAt: at, status, ...(status === 'installed' ? {version: '1.14.48'} : {})});
export const completed = (status = 'installed') => job({state: ['installed', 'missing'].includes(status) ? 'succeeded' : 'failed', result: observed(status), updatedAt: '2026-10-28T00:01:00.000Z'});
// Independent Node SHA oracle uses the backend's documented request order, not the browser implementation.
export const envelope = (saved: CliIntent = intent, value: unknown = job()) => ({requestKey: saved.request.requestKey,
    requestFingerprint: createHash('sha256').update(JSON.stringify({role: saved.role, request: Object.entries(saved.request).sort(([a], [b]) => a.localeCompare(b))})).digest('hex'), job: value});
export const deferred = <T,>() => {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
export const httpError = (status: number) => Object.assign(Error('Controlled transport failure'), {response: {status}});
export const journal = (value: string | null = null) => {
    let raw = value;
    return {getItem: vi.fn(() => raw), setItem: vi.fn((_key: string, next: string) => {raw = next;}), raw: () => raw, foreign: (next: string | null) => {raw = next;}};
};
export function fixture(patch: {raw?: string; role?: string; lock?: CliJournalLock | null; api?: Partial<CliObservationApi>; requestKey?: () => string} = {}) {
    const storage = journal(patch.raw ?? null), controls = {owner: true, enabled: true, cancel: true}, changed = vi.fn();
    let state = initialCliObservation();
    const api: CliObservationApi = {list: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue(job()),
        request: vi.fn().mockResolvedValue(envelope()), cancel: vi.fn().mockResolvedValue(undefined), ...patch.api};
    const controller = createCliObservationController({email, role: patch.role ?? role, deviceId, api, storage,
        lock: patch.lock === null ? undefined : patch.lock ?? (async (_key, change) => change()),
        captureOwner: () => () => controls.owner, canStart: () => controls.enabled, canCancel: () => controls.cancel,
        requestKey: patch.requestKey ?? (() => requestKey), onChange: value => {state = value; changed(value);}});
    controller.activate();
    return {controller, api, storage, controls, changed, state: () => state, initialize: () => controller.refresh(), dispose: () => controller.dispose()};
}
