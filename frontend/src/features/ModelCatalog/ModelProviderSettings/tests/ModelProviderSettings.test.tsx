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

const boundary = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), receipt: vi.fn(), role: 'Разработчик' }));
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
vi.mock('../../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
vi.mock('../../../../core/api', () => ({ baseApi: { defaults: { baseURL: 'https://neurocenter.example.test' } } }));
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
beforeEach(() => {
    vi.clearAllMocks();
    boundary.role = 'Разработчик';
    boundary.read.mockResolvedValue(access);
    boundary.receipt.mockResolvedValue(null);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
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
                <ModelProviderSettings model={model} canManage={canManage} busy={false} onConfigure={configure} />
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
async function enterSecret(secret: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, secret);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
it('opens personal access read-only for a member and separates administrator settings', async () => {
    await render();
    expect(boundary.read).toHaveBeenCalledWith(model.id, expect.any(AbortSignal));
    expect(container.textContent).toContain(access.providerUrl);
    expect(button('Общие настройки провайдера')).toBeUndefined();
    expect(boundary.write).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    boundary.role = 'Главный админ';
    await render(true);
    await click('Общие настройки провайдера');
    expect(configure).toHaveBeenCalledOnce();
    expect(boundary.write).not.toHaveBeenCalled();
});
it('does not expose personal credential controls to an observer', async () => {
    boundary.role = 'Наблюдатель';
    await render();
    expect(container.querySelector('input')).toBeNull();
    expect(boundary.read).not.toHaveBeenCalled();
    expect(boundary.write).not.toHaveBeenCalled();
});
it('explains unavailable key storage and prevents saving', async () => {
    boundary.read.mockResolvedValue({ ...access, canStoreKey: false });
    await render();
    await enterSecret('private-secret');
    expect(container.textContent).toContain('Хранилище личных ключей не настроено');
    expect(button('Сохранить мой ключ')?.disabled).toBe(true);
    expect(boundary.write).not.toHaveBeenCalled();
});
it('offers a read retry after a missing endpoint and never configures it automatically', async () => {
    boundary.read.mockRejectedValueOnce({
        response: { status: 404, data: { message: 'Адрес провайдера не настроен' } },
    });
    await render(true);
    expect(container.querySelector('input')).toBeNull();
    expect(button('Обновить сведения')).toBeDefined();
    await click('Обновить сведения');
    expect(container.textContent).toContain(access.providerUrl);
    expect(configure).not.toHaveBeenCalled();
    expect(boundary.write).not.toHaveBeenCalled();
});
it('preserves entered key after a write failure without persisting the secret', async () => {
    boundary.write.mockRejectedValueOnce(new Error('Connection lost'));
    await render();
    await enterSecret('private-secret');
    await click('Сохранить мой ключ');
    expect(boundary.write).toHaveBeenCalledWith(
        model.id,
        expect.objectContaining({ action: 'save' }),
        'private-secret',
        expect.any(AbortSignal),
    );
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('private-secret');
    const persisted = Object.keys(localStorage)
        .map((key) => localStorage.getItem(key))
        .join('');
    expect(persisted).not.toContain('private-secret');
    expect(button('Проверить сохранение')).toBeDefined();
});
it('keeps recipient information readable with the flag off while disabling key writes', async () => {
    boundary.role = 'Главный админ';
    await render(true, false);
    expect(button('Общие настройки провайдера')?.disabled).toBe(false);
    expect(boundary.read).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(access.providerUrl);
    await enterSecret('private-secret');
    expect(button('Сохранить мой ключ')?.disabled).toBe(true);
    expect(boundary.write).not.toHaveBeenCalled();
});
