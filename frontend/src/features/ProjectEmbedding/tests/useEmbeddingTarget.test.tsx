// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmbeddingTarget } from '../hooks/useEmbeddingTarget';
import { requireProjectEmbeddingTarget } from '../model';
import type { IProjectEmbeddingTarget } from '../model';

const PROJECT = 'prj-1';
const BINDING = 'b'.repeat(64);
const INSTANCE = '12345678-1234-4234-8234-123456789012';
const MANIFEST = 'a'.repeat(64);

const device = {
    id: 'device-1',
    name: 'QA computer',
    online: true,
    report: {
        protocolVersion: 2,
        root: '/qa',
        capabilities: ['hosted-rag-reindex-v1', 'hosted-rag-grants-v1', 'hosted-rag-profile-values-v1'],
        bindings: [{ projectId: PROJECT, bindingId: BINDING, instanceId: INSTANCE, folderName: 'QA', valid: true }],
    },
};
const installation = {
    deviceId: 'device-1',
    projectId: PROJECT,
    assetId: 'asset-1',
    assetKind: 'mcp',
    version: 3,
    name: 'OpenCodeRAG',
    manifest: MANIFEST,
    updatedAt: '',
    bindingId: BINDING,
    hostedEmbedding: { supported: true, reindexSupported: true },
    inspection: {
        schemaVersion: 1,
        projectId: PROJECT,
        bindingId: BINDING,
        assetId: 'asset-1',
        assetKind: 'mcp',
        version: 3,
        manifest: MANIFEST,
        checkedAt: '2026-11-16T00:00:00Z',
        readiness: 'unverified',
        state: 'checked',
        status: 'synced',
        issues: [],
    },
};
const COMPUTER_TARGET: IProjectEmbeddingTarget = {
    mode: 'computer',
    installation: {
        deviceId: 'device-1',
        assetId: 'asset-1',
        assetKind: 'mcp',
        version: 3,
        expectedManifest: MANIFEST,
    },
};

const bridge = vi.hoisted(() => ({
    state: {
        device: undefined as unknown,
        devices: [] as unknown[],
        installations: [] as unknown[],
        jobs: [] as unknown[],
        devicesReady: false,
        jobsReady: false,
        installationsReady: false,
        error: '',
        choose: undefined as unknown,
        reload: async () => undefined,
    },
}));
vi.mock('../../McpBridge/hooks/useBridge', () => ({ useBridge: () => bridge.state }));

const api = vi.hoisted(() => ({
    patch: async () => ({ data: null }),
    get: async () => ({ data: null }),
}));
vi.mock('../../../core/api/base', () => ({ default: api }));

const userState = vi.hoisted(() => ({ role: 'Главный админ' as string }));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({
            userBlock: {
                user: {
                    id: 'owner',
                    email: 'qa@example.test',
                    activeRole: userState.role,
                    userRoles: [userState.role],
                },
            },
        }),
}));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => ({
    useAuthRequestOwner: () => ({ scope: 'actor', captureOwner: () => () => true }),
}));

function readyBridge(patch: Record<string, unknown> = {}) {
    Object.assign(bridge.state, {
        device,
        devices: [device],
        installations: [installation],
        jobs: [],
        devicesReady: true,
        jobsReady: true,
        installationsReady: true,
        error: '',
        choose: vi.fn(),
        ...patch,
    });
}

function Harness({ persisted }: { persisted: IProjectEmbeddingTarget | null | undefined }) {
    const target = useEmbeddingTarget(PROJECT, persisted);
    return (
        <div>
            <span data-testid="mode">{target.mode}</span>
            <span data-testid="item">{target.item?.assetId ?? ''}</span>
            <span data-testid="value">{target.value ? JSON.stringify(target.value) : ''}</span>
            <span data-testid="blocker">{target.blocker ?? ''}</span>
            <button data-testid="server" onClick={() => target.setMode('server')}>
                server
            </button>
            <button data-testid="computer" onClick={() => target.setMode('computer')}>
                computer
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
    userState.role = 'Главный админ';
    api.patch = vi.fn(async () => ({ data: null }));
    Object.assign(bridge.state, {
        device: undefined,
        devices: [],
        installations: [],
        jobs: [],
        devicesReady: false,
        jobsReady: false,
        installationsReady: false,
        error: '',
        choose: vi.fn(),
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('requireProjectEmbeddingTarget', () => {
    it('принимает server и полный computer', () => {
        expect(requireProjectEmbeddingTarget({ mode: 'server' })).toEqual({ mode: 'server', installation: null });
        expect(requireProjectEmbeddingTarget(COMPUTER_TARGET)).toEqual(COMPUTER_TARGET);
        expect(requireProjectEmbeddingTarget(null)).toBeNull();
    });
    it('отклоняет неполные значения', () => {
        expect(() => requireProjectEmbeddingTarget({ mode: 'local' })).toThrow();
        expect(() =>
            requireProjectEmbeddingTarget({ mode: 'server', installation: COMPUTER_TARGET.installation }),
        ).toThrow();
        expect(() => requireProjectEmbeddingTarget({ mode: 'computer' })).toThrow();
        expect(() =>
            requireProjectEmbeddingTarget({
                mode: 'computer',
                installation: { ...COMPUTER_TARGET.installation!, expectedManifest: 'abc' },
            }),
        ).toThrow();
    });
});

describe('useEmbeddingTarget: персист «Куда подключить модель»', () => {
    it('догоняет серверный режим, пока пользователь не тронул выбор', async () => {
        await act(async () => root.render(<Harness persisted={undefined} />));
        expect(testid(container, 'mode').textContent).toBe('computer');
        await act(async () => root.render(<Harness persisted={{ mode: 'server', installation: null }} />));
        expect(testid(container, 'mode').textContent).toBe('server');
        expect(api.patch).not.toHaveBeenCalled();
    });
    it('не догоняет режим после ручного выбора', async () => {
        await act(async () => root.render(<Harness persisted={{ mode: 'server', installation: null }} />));
        await act(async () => testid(container, 'computer').click());
        expect(testid(container, 'mode').textContent).toBe('computer');
        await act(async () => root.render(<Harness persisted={{ mode: 'server', installation: null }} />));
        expect(testid(container, 'mode').textContent).toBe('computer');
    });
    it('поднимает установку из персиста и собирает value', async () => {
        readyBridge();
        await act(async () => root.render(<Harness persisted={COMPUTER_TARGET} />));
        expect(testid(container, 'item').textContent).toBe('asset-1');
        expect(JSON.parse(testid(container, 'value').textContent).deviceId).toBe('device-1');
        // Персист совпадает с состоянием — запись не нужна.
        expect(api.patch).not.toHaveBeenCalled();
    });
    it('сохраняет смену режима на серверную базу', async () => {
        readyBridge();
        await act(async () => root.render(<Harness persisted={COMPUTER_TARGET} />));
        await act(async () => testid(container, 'server').click());
        expect(testid(container, 'mode').textContent).toBe('server');
        expect(api.patch).toHaveBeenCalledOnce();
        expect(api.patch).toHaveBeenCalledWith(expect.stringContaining('/embedding/target'), {
            mode: 'server',
            installation: null,
        });
    });
    it('не затирает персист, пока данные моста не готовы', async () => {
        // bridge не готов (beforeEach)
        await act(async () => root.render(<Harness persisted={COMPUTER_TARGET} />));
        expect(testid(container, 'blocker').textContent).toBe('loading');
        expect(api.patch).not.toHaveBeenCalled();
    });
    it('сбрасывает персист, когда установка исчезла со связанного компьютера', async () => {
        readyBridge({ installations: [] });
        await act(async () => root.render(<Harness persisted={COMPUTER_TARGET} />));
        expect(testid(container, 'blocker').textContent).toBe('installation');
        expect(api.patch).toHaveBeenCalledOnce();
        expect(api.patch).toHaveBeenCalledWith(expect.stringContaining('/embedding/target'), null);
    });
    it('не пишет при роли без права подключения', async () => {
        userState.role = 'Наблюдатель';
        readyBridge({ installations: [] });
        await act(async () => root.render(<Harness persisted={COMPUTER_TARGET} />));
        expect(testid(container, 'blocker').textContent).toBe('installation');
        expect(api.patch).not.toHaveBeenCalled();
    });
});
