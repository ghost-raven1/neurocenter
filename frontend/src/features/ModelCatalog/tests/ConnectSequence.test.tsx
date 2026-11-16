// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConnectSequence } from '../hooks/useConnectSequence';
import type { ICatalogModel } from '../interfaces';

const model: ICatalogModel = {
    id: 'm1',
    name: 'Model',
    description: '',
    capability: 'embedding',
    runtime: 'remote-openai',
    model: 'model',
    manifestSha256: null,
    dimension: 1536,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
};
const other: ICatalogModel = { ...model, id: 'm2' };

function Harness({ plan, run }: { plan: () => Promise<'connection' | 'access' | 'run'>; run: () => Promise<any> }) {
    const sequence = useConnectSequence({ plan, run });
    return (
        <div>
            <span data-testid="phase">{sequence.phase ?? ''}</span>
            <span data-testid="error">{sequence.error}</span>
            {sequence.model && <span data-testid="model">{sequence.model.id}</span>}
            <button data-testid="begin" onClick={() => void sequence.begin(model)}>
                begin
            </button>
            <button data-testid="begin-other" onClick={() => void sequence.begin(other)}>
                begin2
            </button>
            <button data-testid="advance-access" onClick={() => sequence.advance('access')}>
                a
            </button>
            <button data-testid="advance-done" onClick={() => sequence.advance('done')}>
                d
            </button>
            <button data-testid="ready" onClick={() => sequence.markReady()}>
                r
            </button>
            <button data-testid="failed" onClick={() => sequence.markFailed('boom')}>
                f
            </button>
            <button data-testid="retry" onClick={() => sequence.retry()}>
                retry
            </button>
            <button data-testid="close" onClick={() => sequence.close()}>
                close
            </button>
        </div>
    );
}
const testid = (container: HTMLElement, id: string): HTMLElement => {
    const found = container.querySelector(`[data-testid="${id}"]`);
    if (!found) throw new Error('not found: ' + id);
    return found as HTMLElement;
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
it('adaptive plan: step connection is entered without running the operation', async () => {
    const plan = vi.fn(async () => 'connection' as const),
        run = vi.fn(async () => ({ ok: true }));
    await act(async () => root.render(<Harness plan={plan} run={run} />));
    await act(async () => testid(container, 'begin').click());
    expect(plan).toHaveBeenCalledOnce();
    expect(testid(container, 'phase').textContent).toBe('connection');
    expect(run).not.toHaveBeenCalled();
});
it('step access continues to run when the key modal is closed', async () => {
    const plan = vi.fn(async () => 'access' as const),
        run = vi.fn(async () => ({ ok: true, connected: false }));
    await act(async () => root.render(<Harness plan={plan} run={run} />));
    await act(async () => testid(container, 'begin').click());
    expect(testid(container, 'phase').textContent).toBe('access');
    await act(async () => testid(container, 'advance-done').click());
    expect(testid(container, 'phase').textContent).toBe('run');
    expect(run).toHaveBeenCalledOnce();
});
it('direct run finishes ready when the operation is already connected', async () => {
    const plan = vi.fn(async () => 'run' as const),
        run = vi.fn(async () => ({ ok: true, connected: true }));
    await act(async () => root.render(<Harness plan={plan} run={run} />));
    await act(async () => testid(container, 'begin').click());
    expect(testid(container, 'phase').textContent).toBe('ready');
});
it('run waits for the auto-check until markReady confirms the selection', async () => {
    const plan = vi.fn(async () => 'run' as const),
        run = vi.fn(async () => ({ ok: true, connected: false }));
    await act(async () => root.render(<Harness plan={plan} run={run} />));
    await act(async () => testid(container, 'begin').click());
    expect(testid(container, 'phase').textContent).toBe('run');
    await act(async () => testid(container, 'ready').click());
    expect(testid(container, 'phase').textContent).toBe('ready');
});
it('run failure surfaces the error and retry re-runs the operation', async () => {
    const plan = vi.fn(async () => 'run' as const),
        run = vi.fn(async () => ({ ok: false, error: 'Сервер отклонил подключение' }));
    await act(async () => root.render(<Harness plan={plan} run={run} />));
    await act(async () => testid(container, 'begin').click());
    expect(testid(container, 'phase').textContent).toBe('failed');
    expect(testid(container, 'error').textContent).toBe('Сервер отклонил подключение');
    await act(async () => testid(container, 'retry').click());
    expect(run).toHaveBeenCalledTimes(2);
});
it('observed failure during run marks the sequence failed with the check message', async () => {
    const plan = vi.fn(async () => 'run' as const),
        run = vi.fn(async () => ({ ok: true, connected: false }));
    await act(async () => root.render(<Harness plan={plan} run={run} />));
    await act(async () => testid(container, 'begin').click());
    await act(async () => testid(container, 'failed').click());
    expect(testid(container, 'phase').textContent).toBe('failed');
    expect(testid(container, 'error').textContent).toBe('boom');
});
it('late run result for a replaced model does not override the new sequence', async () => {
    const releases: Array<(result: { ok: boolean }) => void> = [];
    const plan = vi.fn(async () => 'run' as const),
        run = vi.fn(
            () =>
                new Promise<{ ok: boolean }>((resolve) => {
                    releases.push(resolve);
                }),
        );
    await act(async () => root.render(<Harness plan={plan} run={run} />));
    await act(async () => testid(container, 'begin').click());
    expect(testid(container, 'phase').textContent).toBe('run');
    await act(async () => testid(container, 'begin-other').click());
    expect(testid(container, 'model').textContent).toBe(other.id);
    await act(async () => {
        releases[0]({ ok: false });
    });
    expect(testid(container, 'phase').textContent).toBe('run');
    expect(testid(container, 'model').textContent).toBe(other.id);
});
