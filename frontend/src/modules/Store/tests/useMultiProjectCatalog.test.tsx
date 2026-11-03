// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMultiProjectCatalog } from '../hooks/useMultiProjectCatalog';
import type { IProjectAsset } from '../../../core/api/interfaces';

const bffMock = vi.hoisted(() => ({ projectCatalog: vi.fn() }));
const sectionUpdatesMock = vi.hoisted(() => vi.fn());
vi.mock('../../../core/api/bff', () => ({ default: bffMock }));
vi.mock('../../../core/socket/hooks/useSectionUpdates', () => ({
    useSectionUpdates: (...args: unknown[]) => sectionUpdatesMock(...args),
}));

const asset = (id: string): IProjectAsset => ({
    assetId: id,
    assetKind: 'mcp',
    addedBy: 'admin',
    addedAt: '2026-11-01T00:00:00Z',
    version: 1,
    manifest: 'm1',
});

function Harness({ ids, scope }: { ids: string[]; scope: string }): JSX.Element {
    const { entries, ready } = useMultiProjectCatalog(ids, scope);
    const view = Object.entries(entries)
        .map(([projectId, entry]) => `${projectId}:${entry.assets.length}:${entry.ready ? 1 : 0}`)
        .join(',');
    return <div>{`${ready ? 'ready' : 'pending'}|${view}`}</div>;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    bffMock.projectCatalog.mockReset();
    bffMock.projectCatalog.mockResolvedValue([]);
    sectionUpdatesMock.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
const render = async (ids: string[], scope: string): Promise<void> => {
    await act(async () => root.render(<Harness ids={ids} scope={scope} />));
};

describe('useMultiProjectCatalog', () => {
    it('makes no requests and no socket subscription for an empty set', async () => {
        await render([], 'owner');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(bffMock.projectCatalog).not.toHaveBeenCalled();
        // The hook runs on every render; with an empty set every run must stay disabled.
        expect(sectionUpdatesMock).toHaveBeenCalled();
        for (const call of sectionUpdatesMock.mock.calls) {
            expect(call[0]).toEqual(['catalog', 'projects', 'access']);
            expect(call[2]).toBe(false);
        }
        expect(container.textContent).toBe('pending|');
    });

    it('reads every project independently and subscribes for auto-reloads', async () => {
        bffMock.projectCatalog.mockImplementation((id: string) =>
            id === 'p2' ? Promise.reject(new Error('down')) : Promise.resolve([asset(id)]),
        );
        await render(['p1', 'p2'], 'owner');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(bffMock.projectCatalog).toHaveBeenCalledTimes(2);
        for (const call of sectionUpdatesMock.mock.calls) {
            expect(call[0]).toEqual(['catalog', 'projects', 'access']);
            expect(call[2]).toBe(true);
        }
        expect(container.textContent).toBe('ready|p1:1:1,p2:0:0');
    });

    it('discards a stale response after the scope changes', async () => {
        let releaseStale: (value: IProjectAsset[]) => void = () => undefined;
        bffMock.projectCatalog.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseStale = resolve;
                }),
        );
        await render(['p1'], 'a');
        await render(['p1'], 'b');
        await act(async () => releaseStale([asset('stale')]));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        // Only the fresh scope-b read (default empty) is visible; the stale one is dropped.
        expect(container.textContent).toBe('ready|p1:0:1');
    });
});
