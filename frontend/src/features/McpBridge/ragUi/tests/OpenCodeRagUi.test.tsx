// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeRagUi } from '../OpenCodeRagUi';
import type { IProjectEmbeddingTarget } from '../../../ProjectEmbedding/model';

const PROJECT = 'prj-1';
const BINDING = 'b'.repeat(64);
const INSTANCE = '12345678-1234-4234-8234-123456789012';

const device = {
    id: 'device-1',
    name: 'QA computer',
    online: true,
    report: {
        protocolVersion: 2,
        root: '/qa',
        capabilities: ['opencode-rag-ui-v1', 'hosted-rag-reindex-v1', 'hosted-rag-grants-v1'],
        bindings: [{ projectId: PROJECT, bindingId: BINDING, instanceId: INSTANCE, folderName: 'QA', valid: true }],
    },
};
const installation = (assetId: string, manifest: string) => ({
    deviceId: 'device-1',
    projectId: PROJECT,
    assetId,
    assetKind: 'mcp',
    version: 3,
    name: 'OpenCodeRAG ' + assetId,
    manifest,
    updatedAt: '',
    bindingId: BINDING,
    hostedEmbedding: { supported: true, reindexSupported: true },
    ragUi: { supported: true, mode: 'web' },
});
const first = installation('asset-1', 'a'.repeat(64));
const second = installation('asset-2', 'c'.repeat(64));
const PERSISTED: IProjectEmbeddingTarget = {
    mode: 'computer',
    installation: {
        deviceId: 'device-1',
        assetId: 'asset-1',
        assetKind: 'mcp',
        version: 3,
        expectedManifest: 'a'.repeat(64),
    },
};

const api = vi.hoisted(() => ({ patch: vi.fn(async () => ({ data: null })) }));
// Стабильная идентичность: useRagUiLauncher держит captureOwner в deps useMemo.
const captureOwner = vi.hoisted(() => () => () => true);
vi.mock('../../../ProjectEmbedding/model', async () => {
    const actual = await vi.importActual<typeof import('../../../ProjectEmbedding/model')>(
        '../../../ProjectEmbedding/model',
    );
    return {
        ...actual,
        projectEmbeddingApi: {
            saveTarget: (id: string, target: unknown) => api.patch('/api/projects/' + id + '/embedding/target', target),
        },
    };
});
vi.mock('../../api', () => ({ bridgeApi: { create: vi.fn(async () => undefined) } }));
vi.mock('../../../UserBlock/hooks/useAuthRequestOwner', () => ({
    useAuthRequestOwner: () => ({ scope: 'actor', captureOwner }),
}));

const bridge = {
    device,
    devices: [device],
    installations: [first, second],
    jobs: [],
    devicesReady: true,
    jobsReady: true,
    installationsReady: true,
    error: '',
    loading: false,
    choose: vi.fn(),
    reload: async () => undefined,
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    api.patch = vi.fn(async () => ({ data: null }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

const openSelect = async (): Promise<void> => {
    const combo = document.querySelector('[role=combobox][aria-label="Установка OpenCodeRAG для открытия"]');
    if (!combo) throw new Error('select not found');
    await act(async () =>
        (combo as HTMLElement)
            .closest('.ant-select-selector')!
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
};
const clickOption = async (label: string): Promise<void> => {
    const option = Array.from(document.querySelectorAll('.ant-select-item-option-content')).find(
        (node) => node.textContent === label,
    );
    if (!option) throw new Error('option not found: ' + label);
    await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('OpenCodeRagUi: персист «Куда подключить модель»', () => {
    it('поднимает установку из персиста проекта', async () => {
        await act(async () =>
            root.render(<OpenCodeRagUi bridge={bridge as never} projectId={PROJECT} canWrite persisted={PERSISTED} />),
        );
        const select = document.querySelector(
            '[aria-label="Установка OpenCodeRAG для открытия"] .ant-select-selection-item',
        );
        expect(select?.textContent).toContain('OpenCodeRAG asset-1');
        expect(container.textContent).toContain('Подключение модели проекта использует выбранную установку.');
        expect(api.patch).not.toHaveBeenCalled();
    });
    it('явный выбор установки сохраняет персист проекта', async () => {
        await act(async () =>
            root.render(<OpenCodeRagUi bridge={bridge as never} projectId={PROJECT} canWrite persisted={PERSISTED} />),
        );
        await openSelect();
        await clickOption('OpenCodeRAG asset-2 · MCP · версия 3');
        expect(api.patch).toHaveBeenCalledOnce();
        expect(api.patch).toHaveBeenCalledWith('/api/projects/prj-1/embedding/target', {
            mode: 'computer',
            installation: {
                deviceId: 'device-1',
                assetId: 'asset-2',
                assetKind: 'mcp',
                version: 3,
                expectedManifest: 'c'.repeat(64),
            },
        });
    });
    it('без персиста единственная установка выбирается без записи', async () => {
        (bridge as { installations: unknown[] }).installations = [first];
        await act(async () =>
            root.render(<OpenCodeRagUi bridge={bridge as never} projectId={PROJECT} canWrite persisted={null} />),
        );
        expect(api.patch).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Открыть OpenCodeRAG в отдельном окне');
    });
});
