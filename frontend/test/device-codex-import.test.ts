import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminSetupHooks, deferredSetup, flushSetup } from './admin-setup-hooks.fixture';
import { OpenCodeImportModal } from '../src/features/ModelCatalog/OpenCodeImportModal';
import { ModelCatalog } from '../src/features/ModelCatalog/ModelCatalog';
import baseApi from '../src/core/api/base';
import { bridgeApi, type IBridgeJob } from '../src/features/McpBridge/api';
import type { ICatalogModel } from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({
    owner: 'owner-a', projectId: 'project-a' as string | undefined, online: true, devicesReady: true,
    bound: true, capabilities: ['opencode-model-scan-v2', 'device-codex-inference-v1'], flags: {} as Record<string, boolean>,
    buttons: new Map<string, { click?: () => void; disabled?: boolean }>(),
    selects: new Map<string, { change: (value: string) => void }>(),
    job: undefined as IBridgeJob | undefined, imported: vi.fn(), configure: vi.fn(), reload: vi.fn(), refresh: vi.fn(),
    localDialogs: [] as string[], remoteDialogs: [] as string[],
}));
let hooks = adminSetupHooks();
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (value: unknown) => hooks.state(value), useRef: (value: unknown) => hooks.ref(value),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => hooks.effect(effect, deps),
    useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => hooks.effect(effect, deps),
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    const owner = ui.owner; return { scope: owner, captureOwner: () => () => owner === ui.owner };
} }));
vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn() } }));
vi.mock('../src/features/McpBridge/api', () => ({ bridgeApi: { create: vi.fn() } }));
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => ({
    devices: [{ id: 'computer-a', name: 'Мой Mac', online: ui.online, report: { capabilities: ui.capabilities,
        bindings: ui.bound ? [{ projectId: 'project-a', bindingId: 'binding-a', instanceId: 'instance-a' }] : [] } }],
    jobs: ui.job ? [ui.job] : [], errors: {}, devicesReady: ui.devicesReady, reload: ui.reload,
}) }));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({ useModelCatalog: () => ({ catalog: { items: [model], assignedModelIds: [] }, loading: false, error: '', refresh: ui.refresh }) }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: {} }));
vi.mock('../src/features/ModelCatalog/ModelCard', () => ({ ModelCard: () => null }));
vi.mock('../src/features/ModelCatalog/ModelDetails', () => ({ ModelDetails: () => null }));
vi.mock('../src/features/ModelCatalog/ModelEditModal', () => ({ ModelEditModal: () => null }));
vi.mock('../src/features/ModelCatalog/DeviceCodexConnectionModal', () => ({ DeviceCodexConnectionModal: ({ model }: { model: ICatalogModel }) => {
    ui.localDialogs.push(model.id); return 'Локальное подключение Codex';
} }));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal', () => ({ RemoteConnectionModal: ({ model }: { model: ICatalogModel }) => {
    ui.remoteDialogs.push(model.id); return 'Серверный API и ключ';
} }));
vi.mock('../src/features/ModelChat/ModelChatModal', () => ({ ModelChatModal: () => null }));
vi.mock('../src/features/Discussions', () => ({ CatalogFeedback: () => null }));
vi.mock('../src/features/OpenCodeProviders/ProviderSetupModal', () => ({ ProviderSetupModal: () => null }));
vi.mock('../src/features/ProjectEmbedding/EmbeddingTarget', () => ({ useEmbeddingTarget: () => ({ blocked: false, mode: 'server', bridge: { devices: [], choose: vi.fn() } }), EmbeddingTargetFields: () => null }));
vi.mock('../src/features/ProjectEmbedding/useProjectReindex', () => ({ useProjectReindex: () => ({ pending: false, busy: false }) }));
vi.mock('../src/features/ProjectEmbedding/ProjectReindexStatus', () => ({ ProjectReindexStatus: () => null }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', async () => {
    const { createElement } = await import('react'), antd = await import('antd');
    const availability = (...features: string[]) => {
        const blocked = features.some(feature => ui.flags[feature] === false);
        return { enabled: !blocked, known: true, loading: false, reason: blocked ? 'Функция выключена главным администратором' : '', refresh: async () => undefined };
    };
    return { useFeatureAvailability: availability, FeatureAvailabilityNotice: () => null,
        FeatureButton: ({ features, disabled, onClick, ...props }: { features: string[]; disabled?: boolean; onClick?: () => void }) => {
            const enabled = availability(...features).enabled;
            return createElement(antd.Button, { ...props, disabled: disabled || !enabled, onClick: () => { if (enabled && !disabled) onClick?.(); } });
        } };
});
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const List = Object.assign(({ dataSource, renderItem }: { dataSource: unknown[]; renderItem: (item: unknown) => ReactNode }) =>
        createElement('div', null, dataSource.map((item, index) => createElement('div', { key: index }, renderItem(item)))), { Item: content });
    return { Modal: content, Space: content, Tag: content, List, Spin: () => null, Tooltip: content, Col: content, Row: content, Empty: content, Checkbox: content, Input: { Search: () => null },
        Select: (props: { 'aria-label': string; onChange: (value: string) => void }) => { ui.selects.set(props['aria-label'], { change: props.onChange }); return null; },
        Typography: { Text: content, Paragraph: content, Title: content },
        Alert: ({ message, description }: { message: string; description?: ReactNode }) => createElement('div', null, message, description),
        Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => {
            if (typeof children === 'string') ui.buttons.set(children, { disabled, click: onClick }); return children;
        },
    };
});

const model = { id: 'local-codex', name: 'Codex на моём Mac', runtime: 'device-codex', capability: 'chat', model: 'codex-fixture' } as ICatalogModel;
const candidate = { candidateId: 'candidate-a', provider: 'codexbridge', name: 'Codex из OpenCode', model: 'codex-fixture', capability: 'chat',
    runtime: null, hasKey: true, blocker: 'codex-local-auth', options: { apiFormat: 'responses', reasoningEffort: 'high', store: false } };
function scan(changes: Record<string, unknown> = {}): IBridgeJob {
    return { id: 'scan-a', deviceId: 'computer-a', state: 'succeeded', result: { schemaVersion: 2, scope: 'project', projectId: 'project-a',
        bindingId: 'binding-a', instanceId: 'instance-a', candidates: [{ ...candidate, ...changes }], warnings: [], expiresAt: '2099-01-01T00:00:00Z' } } as unknown as IBridgeJob;
}
function response() {
    return { data: { model, hasKeyOnComputer: true, localDeviceConnection: { deviceId: 'computer-a', deviceName: 'Мой Mac', scope: 'project',
        projectId: 'project-a', connectionRevision: 1, status: 'unverified', message: 'Запрос модели ещё не проверялся.' } } };
}
function render() {
    hooks.begin(); ui.buttons.clear(); ui.selects.clear();
    const html = renderToStaticMarkup(createElement(OpenCodeImportModal, { projectId: ui.projectId, onClose: vi.fn(), onImported: ui.imported, onConfigureCodex: ui.configure }));
    hooks.commit(); return html;
}
function renderCatalog() {
    hooks.begin(); ui.buttons.clear(); ui.selects.clear(); ui.localDialogs = []; ui.remoteDialogs = [];
    const html = renderToStaticMarkup(createElement(ModelCatalog, { projectId: ui.projectId, canManage: true, isMain: true }));
    hooks.commit(); return html;
}
async function readFromCatalog() {
    vi.mocked(bridgeApi.create).mockResolvedValueOnce(scan()); renderCatalog();
    ui.buttons.get('Из OpenCode')!.click!(); renderCatalog();
    ui.buttons.get('Прочитать OpenCode')!.click!(); await flushSetup(); renderCatalog();
}
async function read(job = scan()) {
    vi.mocked(bridgeApi.create).mockResolvedValueOnce(job); render();
    ui.buttons.get('Прочитать OpenCode')!.click!(); await flushSetup(); return render();
}
function connect() {
    const button = ui.buttons.get('Подключить Codex'); expect(button).toBeDefined(); expect(button!.disabled).not.toBe(true); button!.click!();
}
beforeEach(() => {
    hooks = adminSetupHooks(); vi.clearAllMocks(); ui.owner = 'owner-a'; ui.projectId = 'project-a'; ui.bound = true; ui.online = true;
    ui.devicesReady = true; ui.capabilities = ['opencode-model-scan-v2', 'device-codex-inference-v1']; ui.flags = {}; ui.job = undefined;
    ui.imported.mockResolvedValue(undefined); ui.refresh.mockResolvedValue(undefined); ui.localDialogs = []; ui.remoteDialogs = []; vi.mocked(baseApi.post).mockResolvedValue(response());
});

describe('The catalog routes the real import callback to the matching connection dialog', () => {
    it('a local Codex success opens the computer dialog after refreshing the catalog', async () => {
        await readFromCatalog(); connect(); await flushSetup();
        expect(ui.refresh).toHaveBeenCalledOnce();
        expect(renderCatalog()).toContain('Локальное подключение Codex');
        expect(ui.localDialogs).toEqual([model.id]); expect(ui.remoteDialogs).toEqual([]);
    });

    it('switching project while catalog refresh is pending cannot open a connection in the next project', async () => {
        const held = deferredSetup<void>(); ui.refresh.mockReturnValue(held.promise);
        await readFromCatalog(); connect(); await flushSetup(); expect(ui.refresh).toHaveBeenCalledOnce();
        ui.projectId = 'project-b'; renderCatalog(); renderCatalog();
        held.resolve(); await flushSetup(); renderCatalog();
        expect(ui.localDialogs).toEqual([]); expect(ui.remoteDialogs).toEqual([]);
    });
});
afterEach(() => { hooks.dispose(); vi.restoreAllMocks(); });

describe('Codex import through the existing OpenCode entry point', () => {
    it('connects the exact scan candidate to the selected project without creating a server credential hint', async () => {
        await read(); connect(); await flushSetup();
        expect(baseApi.post).toHaveBeenCalledExactlyOnceWith('/api/models/import-opencode', {
            deviceId: 'computer-a', jobId: 'scan-a', candidateId: 'candidate-a', projectId: 'project-a',
        });
        expect(ui.imported).toHaveBeenCalledExactlyOnceWith(model);
        expect(ui.configure).not.toHaveBeenCalled();
    });

    it('global Codex connects without requiring a project folder', async () => {
        ui.projectId = undefined; ui.bound = false;
        const job = scan(); job.result = { ...job.result, scope: 'global', deviceId: 'computer-a', projectId: undefined, bindingId: undefined, instanceId: undefined };
        await read(job); connect(); await flushSetup();
        expect(baseApi.post).toHaveBeenCalledExactlyOnceWith('/api/models/import-opencode', { deviceId: 'computer-a', jobId: 'scan-a', candidateId: 'candidate-a' });
        expect(ui.imported).toHaveBeenCalledExactlyOnceWith(model);
    });

    it('a failed import retains the candidate and retries exactly the same selection', async () => {
        vi.mocked(baseApi.post).mockRejectedValueOnce(new Error('Компьютер временно недоступен'));
        await read(); connect(); await flushSetup();
        const html = render(); expect(html).toContain(candidate.name); expect(html).toContain('Компьютер временно недоступен');
        expect(ui.imported).not.toHaveBeenCalled(); connect(); await flushSetup();
        expect(baseApi.post).toHaveBeenCalledTimes(2); expect(vi.mocked(baseApi.post).mock.calls[1]).toEqual(vi.mocked(baseApi.post).mock.calls[0]);
        expect(bridgeApi.create).toHaveBeenCalledOnce(); expect(ui.imported).toHaveBeenCalledExactlyOnceWith(model);
    });

    it('a second click before render cannot create a second connection request', async () => {
        const held = deferredSetup<unknown>(); vi.mocked(baseApi.post).mockReturnValue(held.promise);
        await read(); connect(); connect(); expect(baseApi.post).toHaveBeenCalledOnce();
        held.resolve(response()); await flushSetup(); expect(ui.imported).toHaveBeenCalledOnce();
    });

    it.each(['owner', 'project', 'source'])('a late successful import does not open a dialog after the %s changes', async change => {
        const held = deferredSetup<unknown>(); vi.mocked(baseApi.post).mockReturnValue(held.promise);
        await read(); connect();
        if (change === 'owner') ui.owner = 'owner-b';
        else if (change === 'project') ui.projectId = 'project-b';
        else ui.selects.get('Источник конфигурации OpenCode')!.change('global');
        render(); held.resolve(response()); await flushSetup();
        expect(ui.imported).not.toHaveBeenCalled();
    });

    it('a late scan ACK cannot display another project’s candidates', async () => {
        const held = deferredSetup<IBridgeJob>(); vi.mocked(bridgeApi.create).mockReturnValueOnce(held.promise);
        render(); ui.buttons.get('Прочитать OpenCode')!.click!(); ui.projectId = 'project-b'; render();
        held.resolve(scan()); await flushSetup();
        expect(render()).not.toContain(candidate.name); expect(ui.buttons.has('Подключить Codex')).toBe(false);
        expect(ui.reload).not.toHaveBeenCalled();
    });

    it.each(['device_codex_inference', 'codex_connector'])('flag OFF for %s preserves the scan but blocks connection with an explanation', async flag => {
        ui.flags[flag] = false;
        const html = await read(); expect(html).toContain(candidate.name); expect(html).toMatch(/выключен|доступност|включите/i);
        const action = ui.buttons.get('Подключить Codex'); expect(action?.disabled).toBe(true); action?.click?.(); await flushSetup();
        expect(baseApi.post).not.toHaveBeenCalled(); expect(ui.buttons.has('Настроить Codex в OpenCode')).toBe(true);
    });

    it('a bridge lacking device inference explains its update requirement and keeps local setup available', async () => {
        ui.capabilities = ['opencode-model-scan-v2'];
        const html = await read(); expect(html).toMatch(/обновите мост/i); expect(ui.buttons.get('Подключить Codex')?.disabled).toBe(true);
        expect(ui.buttons.has('Настроить Codex в OpenCode')).toBe(true); expect(baseApi.post).not.toHaveBeenCalled();
    });

    it('an old generic Codex classification cannot silently become a remote API import', async () => {
        const html = await read(scan({ blocker: 'unsupported-provider' }));
        expect(html).toContain(candidate.name); expect(ui.buttons.get('Подключить Codex')?.disabled).toBe(true);
        expect(ui.buttons.has('Настроить Codex в OpenCode')).toBe(true); expect(baseApi.post).not.toHaveBeenCalled();
    });

    it.each(['offline', 'devices-unconfirmed', 'capability-revoked', 'flag-disabled', 'expired'])('a retained action cannot submit once %s is observed', async change => {
        await read(); const action = ui.buttons.get('Подключить Codex'); expect(action).toBeDefined();
        if (change === 'offline') ui.online = false;
        else if (change === 'devices-unconfirmed') ui.devicesReady = false;
        else if (change === 'capability-revoked') ui.capabilities = ['opencode-model-scan-v2'];
        else if (change === 'flag-disabled') ui.flags.device_codex_inference = false;
        else vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'));
        render(); action!.click!(); await flushSetup(); expect(baseApi.post).not.toHaveBeenCalled();
    });

    it.each(['runtime', 'device'])('an unconfirmed server %s cannot open any connection dialog', async changed => {
        const reply = response();
        if (changed === 'runtime') reply.data.model = { ...model, runtime: 'remote-openai' };
        else reply.data.localDeviceConnection.deviceId = 'another-computer';
        vi.mocked(baseApi.post).mockResolvedValue(reply);
        await read(); connect(); await flushSetup();
        expect(ui.imported).not.toHaveBeenCalled();
        const html = render(); expect(html).toContain(candidate.name); expect(html).toContain('не подтвердил подключение Codex');
        expect(ui.buttons.get('Подключить Codex')?.disabled).not.toBe(true);
    });

    it('an import ACK after closing the modal cannot open a new connection dialog', async () => {
        const held = deferredSetup<unknown>(); vi.mocked(baseApi.post).mockReturnValue(held.promise);
        await read(); connect(); hooks.dispose(); held.resolve(response()); await flushSetup();
        expect(ui.imported).not.toHaveBeenCalled();
    });

    it('a normal API candidate keeps the remote connection hint contract', async () => {
        const remote = { ...model, id: 'remote-api', runtime: 'remote-openai' as const };
        vi.mocked(baseApi.post).mockResolvedValue({ data: { model: remote, baseUrl: 'https://provider.example.test', hasKeyOnComputer: true } });
        await read(scan({ blocker: null, provider: 'remote', runtime: 'remote-openai' }));
        ui.buttons.get('Импортировать')!.click!(); await flushSetup();
        expect(ui.imported).toHaveBeenCalledExactlyOnceWith(remote, { baseUrl: 'https://provider.example.test', hasKey: true, options: undefined, timeoutMs: undefined });
    });
});
