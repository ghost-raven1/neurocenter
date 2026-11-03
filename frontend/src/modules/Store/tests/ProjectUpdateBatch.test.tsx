// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectUpdateBatch } from '../ProjectUpdateBatch';
import type { IMultiProjectCatalogEntry } from '../hooks/useMultiProjectCatalog';
import type { IStoreApp } from '../../../features/Catalog/interfaces';
import type { IProjectAsset } from '../../../core/api/interfaces';
import type { IBridgeJob } from '../../../features/McpBridge/api';
import { stubModalBrowser } from '../../../features/ModelCatalog/tests/browser.fixture';

const pinMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const onPinnedMock = vi.hoisted(() => vi.fn());
const openProjectMock = vi.hoisted(() => vi.fn());

const head1: IStoreApp = {
    id: 'tool-1',
    name: 'Tool',
    kind: 'mcp',
    description: '',
    version: 3,
    tags: [],
    origin: 'catalog',
};
const head2: IStoreApp = {
    id: 'tool-2',
    name: 'Second',
    kind: 'plugin',
    description: '',
    version: 5,
    tags: [],
    origin: 'catalog',
};
const ref1: IProjectAsset = {
    assetId: 'tool-1',
    assetKind: 'mcp',
    addedBy: 'admin',
    addedAt: '2026-11-01T00:00:00Z',
    version: 2,
    manifest: 'm2',
};
const ref2: IProjectAsset = {
    assetId: 'tool-2',
    assetKind: 'plugin',
    addedBy: 'admin',
    addedAt: '2026-11-01T00:00:00Z',
    version: 4,
    manifest: null,
};
const entry = (assets: IProjectAsset[]): IMultiProjectCatalogEntry => ({ assets, ready: true, error: '' });
const projects = [
    { id: 'p1', name: 'Проект А' },
    { id: 'p2', name: 'Проект Б' },
];
const jobs: IBridgeJob[] = [
    {
        id: 'job-1',
        deviceId: 'dev-1',
        projectId: 'p1',
        kind: 'install',
        state: 'running',
        message: '',
        assetId: 'tool-1',
        assetKind: 'mcp',
        version: '3',
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
    },
];
let root: Root;
let container: HTMLDivElement;
const render = async (props: Partial<Parameters<typeof ProjectUpdateBatch>[0]> = {}): Promise<void> => {
    stubModalBrowser();
    await act(async () =>
        root.render(
            <ProjectUpdateBatch
                projects={projects}
                canManage={() => true}
                byProject={{ p1: entry([ref1]), p2: entry([ref2]) }}
                catalogsReady
                common={[head1, head2]}
                jobs={jobs}
                jobsReady
                captureOwner={() => () => true}
                pin={pinMock}
                onPinned={onPinnedMock}
                onOpenProject={openProjectMock}
                scope="owner"
                {...props}
            />,
        ),
    );
};
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    pinMock.mockReset();
    pinMock.mockResolvedValue({ ok: true });
    onPinnedMock.mockReset();
    openProjectMock.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
const bodyText = (): string => document.body.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
const click = async (node: HTMLElement): Promise<void> => {
    await act(async () => node.click());
};
/** Дожидаемся всю цепочку async-обработчиков (батч из нескольких шагов). */
const settle = async (): Promise<void> => {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
/** Ошибка axios-типа с кодом ответа. */
const axiosFailure = (status: number): Error =>
    Object.assign(new Error(String(status)), { isAxiosError: true, response: { status } });

describe('ProjectUpdateBatch', () => {
    it('lists every project whose pin is behind the common catalog with live statuses', async () => {
        await render();
        expect(bodyText()).toContain('Новее закрепления: 2');
        expect(bodyText()).toContain('Проект А');
        expect(bodyText()).toContain('Проект Б');
        expect(bodyText()).toContain('2 → 3');
        expect(bodyText()).toContain('4 → 5');
        // p1:tool-1 has a running installation job, p2:tool-2 has none.
        expect(bodyText()).toContain('Устанавливается');
        expect(bodyText()).toContain('Не установлена');
        expect(button('Закрепить редакции (2)')).toBeDefined();
    });

    it('hides rows for projects the user cannot manage', async () => {
        await render({ canManage: (projectId) => projectId === 'p1' });
        expect(bodyText()).toContain('Новее закрепления: 1');
        expect(bodyText()).toContain('Проект А');
        expect(bodyText()).not.toContain('Проект Б');
        expect(button('Закрепить редакции (1)')).toBeDefined();
    });

    it('waits for the project catalogs before listing rows', async () => {
        await render({ catalogsReady: false });
        expect(bodyText()).toContain('Читаем каталоги проектов…');
        expect(button('Закрепить редакции (2)')).toBeUndefined();
    });

    it('explains an empty batch and names the catalogs that failed to load', async () => {
        // p1 is up to date (pin equals the head), p2 catalog failed to load.
        await render({
            byProject: {
                p1: entry([{ ...ref1, version: 3, manifest: 'm3' }]),
                p2: { assets: [], ready: false, error: 'Сбой' },
            },
        });
        expect(bodyText()).toContain('Все закреплённые редакции актуальны.');
        expect(bodyText()).toContain('Каталог не прочитан: Проект Б');
        expect(button('Закрепить редакции (0)')?.disabled).toBe(true);
    });

    it('opens the project catalog for the guided install approval', async () => {
        await render();
        const buttons = [...container.querySelectorAll('button')].filter(
            (node) => node.textContent?.trim() === 'Открыть проект',
        );
        expect(buttons).toHaveLength(2);
        await click(buttons[0]);
        expect(openProjectMock).toHaveBeenCalledOnce();
        expect(openProjectMock).toHaveBeenCalledWith('p1');
    });

    it('pins the exact versions sequentially with the CAS payload and refreshes', async () => {
        await render();
        await click(button('Закрепить редакции (2)')!);
        expect(bodyText()).toContain('Эти точные редакции будут закреплены в каждом проекте');
        expect(bodyText()).toContain('Закрепить (2)');
        await click(button('Закрепить (2)')!);
        await settle();
        expect(pinMock).toHaveBeenCalledTimes(2);
        expect(pinMock).toHaveBeenNthCalledWith(1, 'p1', {
            assetId: 'tool-1',
            assetKind: 'mcp',
            version: 3,
            expectedVersion: 2,
            expectedManifest: 'm2',
        });
        expect(pinMock).toHaveBeenNthCalledWith(2, 'p2', {
            assetId: 'tool-2',
            assetKind: 'plugin',
            version: 5,
            expectedVersion: 4,
            expectedManifest: null,
        });
        expect(onPinnedMock).toHaveBeenCalledOnce();
        // The component itself shows the summary; the modal is a portal outside the container.
        expect(container.textContent).toContain('Закреплено: 2 из 2');
    });

    it('reports a parallel pin change as a conflict without stopping the batch', async () => {
        pinMock.mockRejectedValueOnce(axiosFailure(409));
        await render();
        await click(button('Закрепить редакции (2)')!);
        await click(button('Закрепить (2)')!);
        await settle();
        expect(pinMock).toHaveBeenCalledTimes(2);
        expect(bodyText()).toContain('Закрепление изменили параллельно');
        expect(bodyText()).toContain('Закреплено: 1 из 2');
        expect(bodyText()).toContain('1 — закрепление изменили параллельно');
        expect(onPinnedMock).toHaveBeenCalledOnce();
    });

    it('shows the server reason for a failed pin and still refreshes', async () => {
        pinMock.mockRejectedValueOnce(axiosFailure(500));
        await render();
        await click(button('Закрепить редакции (2)')!);
        await click(button('Закрепить (2)')!);
        await settle();
        expect(pinMock).toHaveBeenCalledTimes(2);
        expect(bodyText()).toContain('Закреплено: 1 из 2');
        expect(bodyText()).toContain('1 — ошибка');
        expect(onPinnedMock).toHaveBeenCalledOnce();
    });

    it('stops the batch when the account or role of the initiator changes', async () => {
        let owned = true;
        pinMock.mockImplementation(async () => {
            owned = false;
            return { ok: true };
        });
        await render({ captureOwner: () => () => owned });
        await click(button('Закрепить редакции (2)')!);
        await click(button('Закрепить (2)')!);
        await settle();
        expect(pinMock).toHaveBeenCalledOnce();
        expect(onPinnedMock).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('Закреплено:');
    });

    it('discards the batch outcome when the account changes', async () => {
        await render();
        await click(button('Закрепить редакции (2)')!);
        await click(button('Закрепить (2)')!);
        await settle();
        expect(container.textContent).toContain('Закреплено: 2 из 2');
        await render({ scope: 'other' });
        expect(container.textContent).not.toContain('Закреплено:');
    });

    it('ignores a second confirm click in the same tick', async () => {
        let releasePin: (value: { ok: boolean }) => void = () => undefined;
        pinMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releasePin = resolve;
                }),
        );
        await render();
        await click(button('Закрепить редакции (2)')!);
        const ok = button('Закрепить (2)')!;
        await act(async () => {
            ok.click();
            ok.click();
        });
        expect(pinMock).toHaveBeenCalledOnce();
        await act(async () => releasePin({ ok: true }));
        await settle();
        expect(pinMock).toHaveBeenCalledTimes(2);
        expect(onPinnedMock).toHaveBeenCalledOnce();
        expect(container.textContent).toContain('Закреплено: 2 из 2');
    });

    it('keeps the confirm open and the row busy while the pin is running', async () => {
        let resolvePin: (value: { ok: boolean }) => void = () => undefined;
        pinMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolvePin = resolve;
                }),
        );
        await render();
        await click(button('Закрепить редакции (2)')!);
        await click(button('Закрепить (2)')!);
        await act(async () => {});
        expect(bodyText()).toContain('Закрепить (2)');
        await act(async () => resolvePin({ ok: true }));
        await settle();
        expect(bodyText()).toContain('Закреплено: 2 из 2');
    });
});
