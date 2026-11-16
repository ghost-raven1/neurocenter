// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeatureAvailabilityContext } from '../../FeatureFlags/FeatureAvailability';
import { featureDefinitions } from '../../FeatureFlags/constants';
import type { IEvaluatedFeatureFlags } from '../../FeatureFlags/interfaces';
import type { useBridge } from '../../McpBridge/hooks/useBridge';
import type { IBridgeJob } from '../../McpBridge/api';
import { ModelConnectionStatusPanel } from '../ModelConnectionStatusPanel';
import type { useModelHosting } from '../hooks/useModelHosting';
import type { ICatalogModel, IModelHosting, IRemoteConnection } from '../interfaces';
import type { IPersonalProviderView } from '../../RemoteProviderAccess/model';
import type { IProjectReindexPlan } from '../../ProjectEmbedding/reindex';

const api = vi.hoisted(() => ({ connection: vi.fn(), read: vi.fn() }));
vi.mock('../api', () => ({ modelCatalogApi: { connection: api.connection } }));
vi.mock('../../../core/socket/hooks/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ captureOwner }) };
});
vi.mock('../../RemoteProviderAccess/api', () => ({ personalProviderApi: { read: api.read } }));

const sha = (value: string): string => value.repeat(64);
const DEVICE = '12345678-1234-4234-8234-123456789012';
const PROJECT = 'prj-test-1';
const BINDING = sha('b');
const INSTANCE = '22345678-1234-4234-8234-123456789012';
const PIN = sha('c');

const model: ICatalogModel = {
    id: 'model-1',
    name: 'Remote chat',
    description: '',
    capability: 'chat',
    runtime: 'remote-openai',
    model: 'remote-chat',
    manifestSha256: null,
    verificationSha256: sha('d'),
    dimension: null,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
    modelPin: PIN,
};
const connection: IRemoteConnection = {
    modelId: model.id,
    modelRevision: 1,
    revision: 1,
    baseUrl: 'https://provider.example/v1',
    authMode: 'required',
    requestDimensions: false,
    credential: 'environment',
    credentialEnv: 'PROVIDER_KEY',
    hasKey: false,
    checkedAt: '2026-11-15T00:00:00.000Z',
    verified: true,
    canStoreKey: true,
    options: {},
    timeoutMs: 30000,
};
const access: IPersonalProviderView = {
    modelId: model.id,
    providerId: sha('e'),
    providerUrl: 'https://provider.example/v1',
    connectionRevision: 1,
    authMode: 'required',
    credentialRevision: 1,
    hasKey: true,
    updatedAt: '2026-11-15T00:00:00.000Z',
    canStoreKey: true,
    legacySharedKeyRetained: false,
};
const hosting = (state: IModelHosting, error = ''): ReturnType<typeof useModelHosting> => ({
    hosting: state,
    loading: false,
    busy: false,
    error,
    refresh: async () => undefined,
    operate: vi.fn(),
});
const readyHosting = hosting({ state: 'ready', message: '', checkedAt: '2026-11-15T00:00:00.000Z' });
const statusJob = (state: 'configured' | 'missing'): IBridgeJob => {
    const providerId = 'neurocenter-openai-abcdef1234567890',
        schemaDigest = sha('f');
    return {
        id: '32345678-1234-4234-8234-123456789012',
        deviceId: DEVICE,
        projectId: PROJECT,
        kind: 'get-opencode-provider-status',
        state: 'succeeded',
        message: '',
        createdAt: '2026-11-15T00:00:00.000Z',
        updatedAt: '2026-11-15T00:01:00.000Z',
        bindingId: BINDING,
        expectedInstanceId: INSTANCE,
        providerKind: 'openai-compatible',
        providerId,
        providerSchemaDigest: schemaDigest,
        catalogModelId: model.id,
        expectedModelPin: PIN,
        result: {
            schemaVersion: 1,
            deviceId: DEVICE,
            projectId: PROJECT,
            bindingId: BINDING,
            instanceId: INSTANCE,
            providerKind: 'openai-compatible',
            providerId,
            schemaDigest,
            connector: null,
            catalogModelId: model.id,
            modelPin: PIN,
            state,
            ready: state === 'configured',
            missingFields: state === 'configured' ? [] : ['baseUrl'],
            revision: null,
            checkedAt: '2026-11-15T00:01:00.000Z',
        },
    } as unknown as IBridgeJob;
};
const bridge = (jobs: IBridgeJob[]): ReturnType<typeof useBridge> =>
    ({
        devicesReady: true,
        jobsReady: true,
        errors: { devices: '', jobs: '' },
        device: {
            id: DEVICE,
            name: 'test-device',
            role: 'Разработчик',
            online: true,
            lastSeen: '2026-11-15T00:00:00.000Z',
            report: {
                protocolVersion: 2,
                capabilities: ['durable-completions', 'managed-installations', 'opencode-providers-v1'],
                bindings: [
                    { projectId: PROJECT, folderName: 'proj', valid: true, bindingId: BINDING, instanceId: INSTANCE },
                ],
            },
        },
        jobs,
    }) as unknown as ReturnType<typeof useBridge>;
const plan = (state: IProjectReindexPlan['state'], message: string): IProjectReindexPlan =>
    ({
        id: '42345678-1234-4234-8234-123456789012',
        projectId: PROJECT,
        state,
        digest: sha('a'),
        approved: state !== 'needs_input',
        data: {
            context: { revision: 1, generation: 'initial-' + sha('a').slice(0, 32), dataRevision: 1 },
            modelId: model.id,
            modelPin: PIN,
            profile: {},
            sourceSnapshot: null,
            rowCount: 10,
            requiredBytes: 1000,
        },
        progress: state === 'building' ? 40 : 0,
        message,
        createdAt: '2026-11-15T00:00:00.000Z',
    }) as IProjectReindexPlan;

let root: Root;
let container: HTMLDivElement;
const onConfigure = vi.fn();
const onProviderAccess = vi.fn();
const onSetupProvider = vi.fn();
const noop = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
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
async function render(props: Partial<ComponentProps<typeof ModelConnectionStatusPanel>>): Promise<void> {
    const flags = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, true]),
    ) as IEvaluatedFeatureFlags['flags'];
    const data: IEvaluatedFeatureFlags = {
        flags,
        configured: flags,
        blockedBy: Object.fromEntries(
            featureDefinitions.map(({ key }) => [key, []]),
        ) as IEvaluatedFeatureFlags['blockedBy'],
    };
    await act(async () =>
        root.render(
            <FeatureAvailabilityContext.Provider
                value={{ data, loading: false, error: null, refresh: async () => undefined }}
            >
                <ModelConnectionStatusPanel
                    model={model}
                    canManage
                    hosting={readyHosting}
                    onConfigure={onConfigure}
                    onProviderAccess={onProviderAccess}
                    onSetupProvider={onSetupProvider}
                    {...props}
                />
            </FeatureAvailabilityContext.Provider>,
        ),
    );
}
const findRow = (label: string): HTMLElement | undefined =>
    [...container.querySelectorAll('.model-connection-status__row')].find(
        (row) => row.querySelector('.model-connection-status__label')?.textContent === label,
    );
const row = (label: string): HTMLElement => {
    const value = findRow(label);
    expect(value, label).toBeDefined();
    return value!;
};
const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((value) => value.textContent?.trim() === label);
async function click(label: string): Promise<void> {
    const target = button(label);
    expect(target, label).toBeDefined();
    await act(async () => target!.click());
}

it('главный администратор видит общий адрес, личный ключ и проверку API в одной панели', async () => {
    api.connection.mockResolvedValue(connection);
    api.read.mockResolvedValue(access);
    await render({ personalAccess: true });
    expect(api.connection).toHaveBeenCalledWith(model.id);
    expect(row('Общее подключение').textContent).toContain('https://provider.example/v1');
    expect(row('Общее подключение').textContent).toContain('Личный API-ключ обязателен');
    expect(row('Мой ключ').textContent).toContain('Личный ключ сохранён');
    expect(row('Проверка API').textContent).toContain('Готова');
    expect(row('Проверка API').textContent).toContain('проверено');
    expect(findRow('План переиндексации')).toBeUndefined();
    expect(findRow('Локальный провайдер OpenCode')).toBeUndefined();
    await click('Настроить');
    expect(onConfigure).toHaveBeenCalledOnce();
    expect(onProviderAccess).not.toHaveBeenCalled();
});

it('не главный администратор не читает общий адрес, статус личного ключа остаётся своим', async () => {
    api.read.mockResolvedValue(access);
    await render({ personalAccess: true, canManage: false });
    expect(api.connection).not.toHaveBeenCalled();
    expect(row('Общее подключение').textContent).toContain('главный администратор');
    expect(row('Общее подключение').querySelector('button')).toBeNull();
    expect(row('Мой ключ').textContent).toContain('Личный ключ сохранён');
    expect(row('Мой ключ').querySelector('button')?.textContent).toContain('Настроить');
});

it('строка «Мой ключ» скрывает статус без личных прав', async () => {
    await render({ personalAccess: false });
    expect(api.read).not.toHaveBeenCalled();
    expect(row('Мой ключ').textContent).toContain('—');
});

it('ошибка проверки с упоминанием «Мой доступ» ведёт в настройку доступа', async () => {
    await render({
        hosting: hosting(
            { state: 'stopped', message: '', checkedAt: null },
            'Настройте «Мой доступ»: ключ вводится один раз на провайдера — после проверки работают все модели этого провайдера.',
        ),
    });
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('«Мой доступ»');
    const link = container.querySelector('.model-runtime__setup-access') as HTMLButtonElement;
    expect(link.textContent).toContain('Настроить «Мой доступ»');
    await act(async () => link.click());
    expect(onProviderAccess).toHaveBeenCalledOnce();
});

it('локальный провайдер OpenCode считается из очереди моста без новых запросов', async () => {
    api.connection.mockResolvedValue(connection);
    await render({ personalAccess: true, projectId: PROJECT, bridge: bridge([statusJob('configured')]) });
    expect(row('Локальный провайдер OpenCode').textContent).toContain('Настроен');
    await click('Настроить провайдера в OpenCode');
    expect(onSetupProvider).toHaveBeenCalledOnce();
});

it('без статуса локального провайдера строка помечает его непроверенным', async () => {
    api.connection.mockResolvedValue(connection);
    await render({ personalAccess: true, projectId: PROJECT, bridge: bridge([]) });
    expect(row('Локальный провайдер OpenCode').textContent).toContain('Подключение не проверено');
});

it('план переиндексации для модели показывает подтверждение и повтор', async () => {
    api.connection.mockResolvedValue(connection);
    const start = vi.fn(),
        cancel = vi.fn(),
        retry = vi.fn();
    await render({
        personalAccess: true,
        projectId: PROJECT,
        bridge: bridge([]),
        reindex: { plan: plan('needs_input', 'Подтвердите смену модели'), busy: false, start, retry, cancel },
    });
    expect(row('План переиндексации').textContent).toContain('Нужно подтверждение');
    await click('Подтвердить');
    expect(start).toHaveBeenCalledOnce();
    await click('Отменить');
    expect(cancel).toHaveBeenCalledOnce();
    await render({
        personalAccess: true,
        projectId: PROJECT,
        bridge: bridge([]),
        reindex: { plan: plan('failed', 'Ошибка переиндексации'), busy: false, start, retry, cancel },
    });
    expect(row('План переиндексации').textContent).toContain('Ошибка');
    await click('Повторить');
    expect(retry).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
});

it('план другой модели не попадает в панель', async () => {
    api.connection.mockResolvedValue(connection);
    const other = plan('needs_input', 'Другая модель');
    (other.data as { modelId: string }).modelId = 'other-model';
    await render({
        projectId: PROJECT,
        bridge: bridge([]),
        reindex: { plan: other, busy: false, start: noop, retry: noop, cancel: noop },
    });
    expect(findRow('План переиндексации')).toBeUndefined();
});
