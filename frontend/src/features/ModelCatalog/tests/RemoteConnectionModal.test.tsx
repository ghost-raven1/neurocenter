// @vitest-environment jsdom
import { stubModalBrowser } from './browser.fixture';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteConnectionModal } from '../RemoteConnectionModal';
import { FeatureAvailabilityContext } from '../../FeatureFlags/FeatureAvailability';
import { featureDefinitions } from '../../FeatureFlags/constants';
import type { IEvaluatedFeatureFlags } from '../../FeatureFlags/interfaces';
import type { ICatalogModel } from '../interfaces';
const io = vi.hoisted(() => ({ connection: vi.fn(), configure: vi.fn() }));
vi.mock('../api', () => ({ modelCatalogApi: io }));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
const model: ICatalogModel = {
    id: 'remote',
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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.clearAllMocks();
    stubModalBrowser();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
it('preserves manual endpoint and imported hints after a failed save without submitting on open', async () => {
    const onSaved = vi.fn(),
        onClose = vi.fn();
    io.connection.mockResolvedValue({
        modelId: model.id,
        modelRevision: 1,
        revision: 0,
        baseUrl: '',
        requestDimensions: false,
        authMode: 'required',
        credential: 'none',
        options: {},
        timeoutMs: 90000,
    });
    io.configure.mockRejectedValueOnce(new Error('Save unavailable'));
    const flags = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, true]),
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
                <RemoteConnectionModal
                    model={model}
                    hint={{ baseUrl: 'https://imported.example.test/v1', hasKey: false }}
                    onSaved={onSaved}
                    onClose={onClose}
                />
            </FeatureAvailabilityContext.Provider>,
        ),
    );
    const input = document.querySelector<HTMLInputElement>('input[placeholder="https://provider.example/v1"]');
    expect(input?.value).toBe('https://imported.example.test/v1');
    expect(io.configure).not.toHaveBeenCalled();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            'https://manual.example.test/v1',
        );
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Сохранить провайдера',
    );
    await act(async () => {
        save!.click();
    });
    expect(io.configure).toHaveBeenCalledWith(
        model.id,
        expect.objectContaining({ baseUrl: 'https://manual.example.test/v1' }),
    );
    expect(input?.value).toBe('https://manual.example.test/v1');
    expect(document.body.textContent).toContain('Save unavailable');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
});
