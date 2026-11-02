// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OPENCODE_CLI_INSPECT_JOB } from '@neurocenter/computer-setup';
import { describe, it, expect, vi } from 'vitest';
import type { ICliJob, ICliObservationState } from '../../features/ComputerSetup/model';
import { START_AUTO_CHECK_STALE_MS, startAutoInspectNeeded, useStartAutoInspect } from '../startAutoChecks';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const state = (patch: Partial<ICliObservationState> = {}): ICliObservationState => ({
    busy: false,
    reading: false,
    canReplay: false,
    error: '',
    storageError: '',
    denied: false,
    ...patch,
});
const job = (patch: Partial<ICliJob> = {}): ICliJob => ({
    id: 'job-1',
    deviceId: 'dev-1',
    kind: OPENCODE_CLI_INSPECT_JOB,
    projectId: null,
    state: 'succeeded',
    createdAt: iso(-16 * 60_000),
    updatedAt: iso(-5 * 60_000),
    ...patch,
});

describe('startAutoInspectNeeded', () => {
    it('asks for a fresh check when no observation exists yet', () => {
        expect(startAutoInspectNeeded(state(), NOW)).toBe(true);
    });
    it('never re-checks while the controller is busy, reading, denied, or blocked', () => {
        expect(startAutoInspectNeeded(state({ busy: true }), NOW)).toBe(false);
        expect(startAutoInspectNeeded(state({ reading: true }), NOW)).toBe(false);
        expect(startAutoInspectNeeded(state({ denied: true }), NOW)).toBe(false);
        expect(startAutoInspectNeeded(state({ storageError: 'x' }), NOW)).toBe(false);
    });
    it('never re-checks while a saved intent is still awaiting confirmation or replay', () => {
        const pending = { request: { requestKey: 'k' }, role: 'Разработчик' } as ICliObservationState['intent'];
        expect(startAutoInspectNeeded(state({ intent: pending }), NOW)).toBe(false);
        expect(
            startAutoInspectNeeded(state({ intent: { ...pending, jobId: 'job-1' }, job: job({ state: 'running' }) }), NOW),
        ).toBe(false);
        expect(
            startAutoInspectNeeded(state({ intent: { ...pending, jobId: 'job-9' }, job: job() }), NOW),
        ).toBe(false);
    });
    it('re-checks a stale confirmed observation even with a confirmed (resolved) saved intent', () => {
        // Регрессия: журнал хранит отправку навсегда; подтверждённая отправка
        // не должна блокировать повторную проверку устаревшего состояния.
        const resolved = { request: { requestKey: 'k' }, role: 'Разработчик', jobId: 'job-1' } as ICliObservationState['intent'];
        expect(
            startAutoInspectNeeded(
                state({ intent: resolved, job: job({ observation: { status: 'installed', version: '1' }, updatedAt: iso(-16 * 60_000) }) }),
                NOW,
            ),
        ).toBe(true);
        expect(
            startAutoInspectNeeded(
                state({ intent: resolved, job: job({ observation: { status: 'installed', version: '1' } }) }),
                NOW,
            ),
        ).toBe(false);
    });
    it('does not interrupt a check in flight', () => {
        for (const value of ['queued', 'running', 'reconciling'] as const)
            expect(startAutoInspectNeeded(state({ job: job({ state: value }) }), NOW)).toBe(false);
    });
    it('keeps a fresh confirmed observation', () => {
        expect(startAutoInspectNeeded(state({ job: job({ observation: { status: 'installed', version: '1' } }) }), NOW)).toBe(false);
        expect(startAutoInspectNeeded(state({ job: job({ observation: { status: 'missing' } }) }), NOW)).toBe(false);
        // Граничный возраст считается ещё актуальным.
        expect(
            startAutoInspectNeeded(state({ job: job({ observation: { status: 'installed', version: '1' }, updatedAt: iso(-START_AUTO_CHECK_STALE_MS) }) }), NOW),
        ).toBe(false);
    });
    it('re-checks a confirmed observation after the staleness window', () => {
        expect(
            startAutoInspectNeeded(state({ job: job({ observation: { status: 'installed', version: '1' }, updatedAt: iso(-START_AUTO_CHECK_STALE_MS - 1) }) }), NOW),
        ).toBe(true);
    });
    it('re-checks unconfirmed terminal results: failure, timeout, missing receipt, invalid time', () => {
        expect(startAutoInspectNeeded(state({ job: job({ state: 'failed' }) }), NOW)).toBe(true);
        expect(startAutoInspectNeeded(state({ job: job({ observation: { status: 'timed-out' } }) }), NOW)).toBe(true);
        expect(startAutoInspectNeeded(state({ job: job() }), NOW)).toBe(true);
        expect(startAutoInspectNeeded(state({ job: job({ updatedAt: 'не дата' }) }), NOW)).toBe(true);
    });
    it('never repeats an explicitly cancelled check', () => {
        expect(
            startAutoInspectNeeded(state({ job: job({ state: 'cancelled', updatedAt: iso(-16 * 60_000) }) }), NOW),
        ).toBe(false);
    });
});

interface IProbeProps {
    enabled: boolean;
    flag: boolean;
    deviceId?: string;
    canStart: boolean;
    state: ICliObservationState;
    start(): void;
}
function Probe(props: IProbeProps) {
    useStartAutoInspect(props);
    return null;
}
async function renderProbe(props: IProbeProps) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let current = props;
    await act(async () => root.render(<Probe {...current} />));
    return {
        set(next: IProbeProps) {
            current = next;
            return act(async () => root.render(<Probe {...current} />));
        },
        async unmount() {
            await act(async () => root.unmount());
            container.remove();
            vi.unstubAllGlobals();
        },
    };
}

describe('useStartAutoInspect', () => {
    const stale = () => state({ job: job({ state: 'failed' }) });
    const fresh = () => state({ job: job({ observation: { status: 'installed', version: '1' } }) });
    const base: IProbeProps = { enabled: true, flag: true, deviceId: 'dev-1', canStart: true, state: stale(), start: vi.fn() };

    it('does nothing when the flag is off, even with a stale state', async () => {
        const start = vi.fn();
        const app = await renderProbe({ ...base, flag: false, start });
        await app.unmount();
        expect(start).not.toHaveBeenCalled();
    });
    it('keeps a fresh confirmed observation untouched', async () => {
        const start = vi.fn();
        const app = await renderProbe({ ...base, state: fresh(), start });
        await app.unmount();
        expect(start).not.toHaveBeenCalled();
    });
    it('waits for the load to settle, checks once, and does not repeat on re-renders', async () => {
        const start = vi.fn();
        const app = await renderProbe({ ...base, state: state({ busy: true }), start });
        expect(start).not.toHaveBeenCalled();
        await app.set({ ...base, start, state: stale() });
        expect(start).toHaveBeenCalledTimes(1);
        // Новая идентичность того же устаревшего состояния не создаёт дубля.
        await app.set({ ...base, start, state: stale() });
        expect(start).toHaveBeenCalledTimes(1);
        await app.unmount();
    });
    it('starts a new check for a newly selected computer', async () => {
        const start = vi.fn();
        const app = await renderProbe({ ...base, state: state({ busy: true }), start });
        await app.set({ ...base, start, state: stale() });
        expect(start).toHaveBeenCalledTimes(1);
        await app.set({ ...base, start, deviceId: 'dev-2', state: stale() });
        expect(start).toHaveBeenCalledTimes(2);
        await app.unmount();
    });
    it('waits for canStart and checks after the blocker clears', async () => {
        const start = vi.fn();
        const app = await renderProbe({ ...base, canStart: false, start });
        expect(start).not.toHaveBeenCalled();
        await app.set({ ...base, start, canStart: true, state: stale() });
        expect(start).toHaveBeenCalledTimes(1);
        await app.unmount();
    });
    it('does not duplicate a saved intent awaiting replay', async () => {
        const start = vi.fn();
        const pending = state({
            intent: { request: { requestKey: 'k' }, role: 'Разработчик' } as ICliObservationState['intent'],
        });
        const app = await renderProbe({ ...base, state: pending, start });
        expect(start).not.toHaveBeenCalled();
        await app.unmount();
    });
});
