// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAssetImports } from '../useAssetImports';
import type { IAssetImport } from '../../interfaces';

const io = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), scope: 'owner', generation: 0 }));
vi.mock('../../../../core/api', () => ({ baseApi: io }));
const captureOwner = () => {
    const generation = io.generation;
    return () => generation === io.generation;
};
vi.mock('../../../UserBlock/hooks/useAuthRequestOwner', () => ({
    useAuthRequestOwner: () => ({ scope: io.scope, captureOwner }),
}));
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const job: IAssetImport = { id, state: 'FAILED', planDigest: 'digest', message: 'Failed', items: [] };
let root: Root;
let container: HTMLDivElement;
let view: ReturnType<typeof useAssetImports>;
const completed = vi.fn();
function Probe(): null {
    view = useAssetImports(completed);
    return null;
}
async function render(): Promise<void> {
    await act(async () => {
        root.render(<Probe />);
    });
}
beforeEach(() => {
    vi.clearAllMocks();
    io.scope = 'owner';
    io.generation++;
    localStorage.clear();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    io.get.mockResolvedValue({ data: job });
    io.post.mockResolvedValue({ data: job });
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});
it('opens exact accepted import without admission or overwriting storage and retries that same job explicitly', async () => {
    await render();
    await act(async () => view.recover(id));
    expect(io.get).toHaveBeenCalledWith('/api/asset-imports/' + id);
    expect(view.job?.id).toBe(id);
    expect(localStorage.length).toBe(0);
    expect(io.post).not.toHaveBeenCalled();
    await act(async () => view.retry());
    expect(io.post).toHaveBeenCalledWith('/api/asset-imports/' + id + '/retry', undefined);
});
it('keeps an uncertain saved request and its idempotency key when another import is opened', async () => {
    const saved = { requestKey: other, commit: 'a'.repeat(40), ids: ['skill'] };
    localStorage.setItem('asset-import:owner', JSON.stringify(saved));
    io.get.mockRejectedValue(new Error('Offline'));
    await render();
    await act(async () => view.recover(id));
    expect(view.intent?.requestKey).toBe(other);
    expect(view.error).toContain('не заменён');
    expect(io.get).toHaveBeenCalledTimes(1);
    expect(io.post).not.toHaveBeenCalled();
    await act(async () => view.repeat());
    expect(io.post).toHaveBeenCalledWith('/api/asset-imports', saved);
});
it('does not replace another displayed accepted import', async () => {
    await render();
    await act(async () => view.recover(id));
    await act(async () => view.recover(other));
    expect(view.job?.id).toBe(id);
    expect(io.get).toHaveBeenCalledTimes(1);
    expect(view.error).toContain('не заменено');
});
it('rejects an invalid link before IO', async () => {
    await render();
    await act(async () => view.recover('../other'));
    expect(io.get).not.toHaveBeenCalled();
    expect(view.error).toContain('Некорректная');
});
it('keeps a failed lookup retryable without creating a request', async () => {
    await render();
    io.get.mockRejectedValueOnce(new Error('Offline'));
    await act(async () => view.recover(id));
    expect(view.job).toBeUndefined();
    await act(async () => view.recover(id));
    expect(view.job?.id).toBe(id);
    expect(io.post).not.toHaveBeenCalled();
});
it('discards a late answer after the owner changes', async () => {
    let resolve!: (value: { data: IAssetImport }) => void;
    io.get.mockReturnValue(
        new Promise((done) => {
            resolve = done;
        }),
    );
    await render();
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.recover(id);
    });
    io.scope = 'next-owner';
    io.generation++;
    await render();
    await act(async () => {
        resolve({ data: job });
        await pending;
    });
    expect(view.job).toBeUndefined();
    expect(localStorage.length).toBe(0);
    expect(io.post).not.toHaveBeenCalled();
});
it('rejects a mismatched server identity without accepting a different job', async () => {
    io.get.mockResolvedValue({ data: { ...job, id: other } });
    await render();
    await act(async () => view.recover(id));
    expect(view.job).toBeUndefined();
    expect(view.error).toContain('другой импорт');
});
it('accepts only the latest link when an earlier read completes late', async () => {
    let resolve!: (value: { data: IAssetImport }) => void;
    io.get.mockReturnValueOnce(
        new Promise((done) => {
            resolve = done;
        }),
    );
    await render();
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.recover(id);
    });
    io.get.mockResolvedValue({ data: { ...job, id: other } });
    await act(async () => view.recover(other));
    await act(async () => {
        resolve({ data: job });
        await pending;
    });
    expect(view.job?.id).toBe(other);
    expect(io.post).not.toHaveBeenCalled();
});
it('discards the answer when navigation removes the recovery link', async () => {
    let resolve!: (value: { data: IAssetImport }) => void;
    io.get.mockReturnValueOnce(
        new Promise((done) => {
            resolve = done;
        }),
    );
    await render();
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.recover(id);
    });
    await act(async () => view.cancelRecovery());
    await act(async () => {
        resolve({ data: job });
        await pending;
    });
    expect(view.job).toBeUndefined();
    expect(view.busy).toBe(false);
});
