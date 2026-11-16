// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelProviderSettings } from '../ModelProviderSettings';
import { FeatureAvailabilityContext } from '../../../FeatureFlags/FeatureAvailability';
import { featureDefinitions } from '../../../FeatureFlags/constants';
import type { IEvaluatedFeatureFlags } from '../../../FeatureFlags/interfaces';
import type { ICatalogModel } from '../../interfaces';
import type { IPersonalProviderView } from '../../../RemoteProviderAccess/model';

const boundary = vi.hoisted(() => ({ read: vi.fn(), role: 'Разработчик' }));
vi.mock('../../../RemoteProviderAccess/api', () => ({ personalProviderApi: boundary }));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({
            userBlock: {
                user: {
                    id: 'owner',
                    principalName: 'owner',
                    email: 'owner@example.test',
                    activeRole: boundary.role,
                    userRoles: [boundary.role],
                },
            },
        }),
}));

const model: ICatalogModel = {
    id: 'remote-model',
    name: 'Remote',
    description: '',
    capability: 'chat',
    runtime: 'remote-openai',
    model: 'remote',
    manifestSha256: null,
    dimension: null,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
};
const access: IPersonalProviderView = {
    modelId: model.id,
    providerId: 'a'.repeat(64),
    providerUrl: 'https://provider.example.test/v1',
    connectionRevision: 1,
    authMode: 'required',
    credentialRevision: 0,
    hasKey: false,
    updatedAt: null,
    canStoreKey: true,
    legacySharedKeyRetained: false,
};
let root: Root;
let container: HTMLDivElement;
const configure = vi.fn();
const openAccess = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    boundary.role = 'Разработчик';
    boundary.read.mockResolvedValue(access);
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
async function render(canManage = false, enabled = true): Promise<void> {
    const flags = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, key === 'personal_remote_provider_credentials' ? enabled : true]),
    ) as IEvaluatedFeatureFlags['flags'];
    const data: IEvaluatedFeatureFlags = {
        flags,
        configured: flags,
        blockedBy: Object.fromEntries(
            featureDefinitions.map(({ key }) => [key, [] as IEvaluatedFeatureFlags['blockedBy'][typeof key]]),
        ) as IEvaluatedFeatureFlags['blockedBy'],
    };
    await act(async () =>
        root.render(
            <FeatureAvailabilityContext.Provider
                value={{ data, loading: false, error: null, refresh: async () => undefined }}
            >
                <ModelProviderSettings
                    model={model}
                    canManage={canManage}
                    busy={false}
                    onConfigure={configure}
                    onProviderAccess={openAccess}
                />
            </FeatureAvailabilityContext.Provider>,
        ),
    );
}
function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((value) => value.textContent?.trim() === label);
}
async function click(label: string): Promise<void> {
    const target = button(label);
    expect(target, label).toBeDefined();
    await act(async () => target!.click());
}
it('показывает read-only статус и единственное вход «Мой доступ» (без inline-ключа)', async () => {
    await render();
    expect(boundary.read).toHaveBeenCalledWith(model.id, expect.any(AbortSignal));
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('Нужен ваш API-ключ');
    expect(button('Общие настройки провайдера')).toBeUndefined();
    await click('Мой доступ');
    expect(openAccess).toHaveBeenCalledOnce();
    expect(configure).not.toHaveBeenCalled();
});
it('показывает статус сохранённого личного ключа', async () => {
    boundary.read.mockResolvedValue({ ...access, hasKey: true });
    await render();
    expect(container.textContent).toContain('Личный ключ сохранён');
});
it('главный администратор сохраняет доступ к общим настройкам рядом с входом в «Мой доступ»', async () => {
    boundary.role = 'Главный админ';
    await render(true);
    expect(button('Мой доступ')).toBeDefined();
    await click('Общие настройки провайдера');
    expect(configure).toHaveBeenCalledOnce();
    expect(openAccess).not.toHaveBeenCalled();
});
it('наблюдателю не доступны ни статус, ни вход в «Мой доступ»', async () => {
    boundary.role = 'Наблюдатель';
    await render();
    expect(container.querySelector('input')).toBeNull();
    expect(boundary.read).not.toHaveBeenCalled();
    expect(button('Мой доступ')).toBeUndefined();
});
it('ошибка чтения статуса не показывает контролы ключа', async () => {
    boundary.read.mockRejectedValueOnce({
        response: { status: 404, data: { message: 'Адрес провайдера не настроен' } },
    });
    await render(true);
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('Не удалось проверить личный доступ');
    expect(button('Мой доступ')).toBeDefined();
    expect(configure).not.toHaveBeenCalled();
});
it('с выключенным флагом статус не читается и вход скрыт', async () => {
    await render(true, false);
    expect(boundary.read).not.toHaveBeenCalled();
    expect(button('Мой доступ')).toBeUndefined();
    expect(button('Общие настройки провайдера')).toBeDefined();
});
