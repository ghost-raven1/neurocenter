// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderAccessModal } from '../ProviderAccessModal';
import type { ICatalogModel } from '../interfaces';

// Личный ключ («Мой доступ») рендерим заглушкой: тестируем ролевую развёртку модалки, а не API.
vi.mock('../../RemoteProviderAccess/RemoteProviderAccess', () => ({
    RemoteProviderAccess: ({ modelId }: { modelId: string }) => (
        <div data-testid="personal-key" data-model-id={modelId} />
    ),
}));
// FeatureButton без FeatureAvailabilityProvider fail-closed; прокидываем анtd-кнопку как есть.
vi.mock('../../FeatureFlags/FeatureAvailability', async () => {
    const { Button } = await import('antd');
    return {
        FeatureButton: ({
            features: _features,
            disabled,
            onClick,
            ...props
        }: { features: unknown } & Record<string, unknown>) => (
            <Button {...(props as object)} disabled={disabled} onClick={onClick as () => void} />
        ),
    };
});

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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});
const bodyText = (): string => document.body.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
// non-main: canConfigure=false, onConfigure=undefined — адрес настраивает главный админ,
// но личный ключ доступен; модалка не должна быть dead-end (P1-1).
it('non-main: hides the shared-address editor but keeps the personal key', async () => {
    await act(async () =>
        root.render(<ProviderAccessModal model={model} canConfigure={false} busy={false} onClose={vi.fn()} />),
    );
    expect(button('Изменить адрес и настройки провайдера')).toBeUndefined();
    expect(bodyText()).toContain('Общий адрес провайдера настраивает главный администратор.');
    expect(document.querySelector('[data-testid="personal-key"]')).not.toBeNull();
});
// main: canConfigure=true + onConfigure — кнопка адреса видна и вызывает хэндлер.
it('main: shows the shared-address editor and wires it to onConfigure', async () => {
    const onConfigure = vi.fn(),
        onClose = vi.fn();
    await act(async () =>
        root.render(
            <ProviderAccessModal
                model={model}
                canConfigure={true}
                busy={false}
                onConfigure={onConfigure}
                onClose={onClose}
            />,
        ),
    );
    const action = button('Изменить адрес и настройки провайдера');
    expect(action).toBeDefined();
    expect(bodyText()).not.toContain('Общий адрес провайдера настраивает главный администратор.');
    await act(async () => action!.click());
    expect(onConfigure).toHaveBeenCalledOnce();
});
// canConfigure=true, но onConfigure не передан — кнопка всё равно скрыта (двойной шлюз).
it('without onConfigure the editor stays hidden even when canConfigure=true', async () => {
    await act(async () =>
        root.render(<ProviderAccessModal model={model} canConfigure={true} busy={false} onClose={vi.fn()} />),
    );
    expect(button('Изменить адрес и настройки провайдера')).toBeUndefined();
});
// busy: «Закрыть» заблокирован, чтобы не терять сохраняющийся ключ.
it('locks the close action while busy', async () => {
    await act(async () =>
        root.render(<ProviderAccessModal model={model} canConfigure={false} busy={true} onClose={vi.fn()} />),
    );
    expect(button('Закрыть')?.disabled).toBe(true);
});
