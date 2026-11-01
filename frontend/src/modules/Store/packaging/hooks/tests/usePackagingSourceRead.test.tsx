// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { usePackagingSourceRead } from '../usePackagingSourceRead';
import type { IPackagingSourceReadOptions } from '../usePackagingSourceRead.interfaces';
const io = vi.hoisted(() => ({ files: vi.fn(), archive: vi.fn() }));
vi.mock('../../sourceFiles', () => ({ readPackagingFiles: io.files }));
vi.mock('../../sourceArchive', () => ({ readPackagingArchive: io.archive }));
let root: Root,
    container: HTMLDivElement,
    options: IPackagingSourceReadOptions,
    view: ReturnType<typeof usePackagingSourceRead>,
    owner: boolean;
const source = { files: [{ path: 'entry.js', content: 'ok' }], skipped: 2 };
const input = [new File(['x'], 'source.zip')];
function Probe() {
    view = usePackagingSourceRead(options);
    return null;
}
async function render() {
    await act(async () => root.render(<Probe />));
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    owner = true;
    options = {
        context: {},
        source: 'files',
        enabled: true,
        blocked: false,
        captureCurrent: () => () => owner,
        onReading: vi.fn(),
        onStart: vi.fn(),
        onRead: vi.fn(),
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    io.files.mockResolvedValue(source);
    io.archive.mockResolvedValue(source);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
it.each(['size', 'malformed', 'network'])(
    '%s failure does not replace the previous selection and successful retry does',
    async (error) => {
        await render();
        io.archive.mockRejectedValueOnce(Error(error));
        await act(async () => view.read(input, true));
        expect(options.onRead).not.toHaveBeenCalled();
        expect(view.error).toBe(error);
        await act(async () => view.read(input, true));
        expect(options.onRead).toHaveBeenCalledWith(source, 'source.zip', expect.any(Function));
        expect(view.error).toBe('');
    },
);
it.each(['owner', 'close', 'source', 'flag'])('late read cannot commit after %s changes', async (change) => {
    let resolve!: (value: typeof source) => void;
    io.files.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    await render();
    let pending!: Promise<void>;
    act(() => {
        pending = view.read(input);
    });
    if (change === 'owner') owner = false;
    if (change === 'close') options = { ...options, context: {} };
    if (change === 'source') options = { ...options, source: 'npm' };
    if (change === 'flag') options = { ...options, enabled: false };
    await render();
    await act(async () => {
        resolve(source);
        await pending;
    });
    expect(options.onRead).not.toHaveBeenCalled();
});
it('in-flight selection stays untouched and double selection does not start a second read', async () => {
    let resolve!: (value: typeof source) => void;
    io.files.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    await render();
    let pending!: Promise<void>;
    act(() => {
        pending = view.read(input);
    });
    await act(async () => view.read(input));
    expect(io.files).toHaveBeenCalledTimes(1);
    expect(options.onRead).not.toHaveBeenCalled();
    await act(async () => {
        resolve(source);
        await pending;
    });
    expect(options.onRead).toHaveBeenCalledTimes(1);
});
it('OFF stops reading state and permits explicit retry after ON', async () => {
    let reject!: (reason: Error) => void;
    io.files.mockImplementationOnce(
        () =>
            new Promise((_resolve, r) => {
                reject = r;
            }),
    );
    await render();
    let pending!: Promise<void>;
    act(() => {
        pending = view.read(input);
    });
    options = { ...options, enabled: false };
    await render();
    expect(options.onReading).toHaveBeenLastCalledWith(false);
    await act(async () => {
        reject(Error('late'));
        await pending;
    });
    expect(view.error).not.toBe('late');
    options = { ...options, enabled: true };
    await render();
    await act(async () => view.read(input));
    expect(options.onRead).toHaveBeenCalledTimes(1);
});
it.each(['close-reopen', 'off-on'])('rejects old completion after %s returns to the same context', async (mode) => {
    let resolve!: (value: typeof source) => void;
    io.files.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    await render();
    const original = options;
    let pending!: Promise<void>;
    act(() => {
        pending = view.read(input);
    });
    options = mode === 'off-on' ? { ...options, enabled: false } : { ...options, context: {} };
    await render();
    options = original;
    await render();
    await act(async () => {
        resolve(source);
        await pending;
    });
    expect(options.onRead).not.toHaveBeenCalled();
});
