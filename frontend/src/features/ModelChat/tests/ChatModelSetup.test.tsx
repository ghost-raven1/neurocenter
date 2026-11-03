// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModelSetup } from '../ChatModelSetup';
import type { ICatalogModel } from '../../ModelCatalog/interfaces';

const apiMock = vi.hoisted(() => ({
    assign: vi.fn(async () => ({ ok: true })),
    operate: vi.fn(async () => ({ state: 'ready', message: '', checkedAt: null })),
}));
vi.mock('../../ModelCatalog/api', () => ({ modelCatalogApi: apiMock }));
// Личный ключ («Мой доступ») рендерим заглушкой: тестируем цепочку, а не API ключа.
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
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => ({
    useAuthRequestOwner: () => ({ scope: 'test', captureOwner: () => () => true }),
}));
// Модалка подключения провайдера: контракт реального — onSaved затем onClose,
// при отказе onSaved остаётся открытой с ошибкой.
vi.mock('../../ModelCatalog/RemoteConnectionModal', async () => {
    const { useState } = await import('react');
    return {
        RemoteConnectionModal: ({
            onClose,
            onSaved,
        }: {
            model: unknown;
            onClose: () => void;
            onSaved: () => Promise<void>;
        }) => {
            const [failed, setFailed] = useState(false);
            return (
                <div data-testid="connection-modal">
                    {failed && <div data-testid="connection-error">Ошибка сохранения</div>}
                    <button
                        type="button"
                        data-testid="connection-save"
                        onClick={() => {
                            void onSaved()
                                .then(onClose)
                                .catch(() => setFailed(true));
                        }}
                    >
                        Сохранить подключение
                    </button>
                    <button type="button" onClick={onClose}>
                        Закрыть
                    </button>
                </div>
            );
        },
    };
});
import { stubModalBrowser } from '../../ModelCatalog/tests/browser.fixture';

const model = (patch: Partial<ICatalogModel> = {}): ICatalogModel => ({
    id: 'm1',
    name: 'Model',
    description: '',
    capability: 'chat',
    runtime: 'remote-openai',
    model: 'model',
    manifestSha256: null,
    verificationSha256: null,
    dimension: null,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...patch,
});
const verified = 'a'.repeat(64);
let root: Root;
let container: HTMLDivElement;
const render = async (props: {
    items: ICatalogModel[];
    assigned?: Set<string>;
    canAssign?: boolean;
    canCheck?: boolean;
    canConfigure?: boolean;
    onRefresh?: () => void | Promise<void>;
}): Promise<void> => {
    stubModalBrowser();
    await act(async () =>
        root.render(
            <ChatModelSetup
                projectId="p1"
                items={props.items}
                assigned={props.assigned ?? new Set()}
                canAssign={props.canAssign ?? false}
                canCheck={props.canCheck ?? false}
                canConfigure={props.canConfigure ?? false}
                onRefresh={props.onRefresh ?? vi.fn()}
            />,
        ),
    );
};
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiMock.assign.mockReset();
    apiMock.operate.mockReset();
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

describe('ChatModelSetup', () => {
    it('adds an unassigned model to the project and refreshes the catalog', async () => {
        const onRefresh = vi.fn();
        await render({ items: [model({ verificationSha256: verified })], canAssign: true, onRefresh });
        const action = button('Добавить в проект');
        expect(action).toBeDefined();
        await click(action!);
        expect(apiMock.assign).toHaveBeenCalledOnce();
        expect(apiMock.assign).toHaveBeenCalledWith('p1', 'm1');
        expect(onRefresh).toHaveBeenCalledOnce();
    });

    it('does not offer the assignment to a role that cannot assign', async () => {
        await render({ items: [model({ verificationSha256: verified })], canAssign: false });
        expect(button('Добавить в проект')).toBeUndefined();
        expect(bodyText()).toContain('Добавить модель в проект может администратор проекта.');
    });

    it('offers the provider and the connection check to the main admin of an unverified remote model', async () => {
        await render({
            items: [model()],
            assigned: new Set(['m1']),
            canAssign: true,
            canCheck: true,
            canConfigure: true,
        });
        expect(button('Настроить провайдера и ключ')).toBeDefined();
        expect(button('Проверить подключение')).toBeDefined();
    });

    it('keeps the key step for a role that cannot verify', async () => {
        await render({ items: [model()], assigned: new Set(['m1']), canAssign: true, canCheck: false });
        expect(button('Настроить провайдера и ключ')).toBeDefined();
        expect(button('Проверить подключение')).toBeUndefined();
        expect(bodyText()).toContain('Проверку подключения после сохранения выполняет главный администратор.');
    });

    it('opens the provider and key modal for an unverified remote model', async () => {
        await render({ items: [model()], assigned: new Set(['m1']), canAssign: true });
        const action = button('Настроить провайдера и ключ');
        expect(action).toBeDefined();
        await click(action!);
        // non-main: shared address is hidden, the personal key stays reachable.
        expect(button('Изменить адрес и настройки провайдера')).toBeUndefined();
        expect(bodyText()).toContain('Общий адрес провайдера настраивает главный администратор.');
        expect(document.querySelector('[data-testid="personal-key"]')).not.toBeNull();
    });

    it('runs the provider → connection → key chain for the main admin and refreshes after the save', async () => {
        const onRefresh = vi.fn();
        await render({
            items: [model()],
            assigned: new Set(['m1']),
            canAssign: true,
            canCheck: true,
            canConfigure: true,
            onRefresh,
        });
        await click(button('Настроить провайдера и ключ')!);
        expect(button('Изменить адрес и настройки провайдера')).toBeDefined();
        await click(button('Изменить адрес и настройки провайдера')!);
        expect(document.querySelector('[data-testid="connection-modal"]')).not.toBeNull();
        await click(document.querySelector('[data-testid="connection-save"]')!);
        expect(onRefresh).toHaveBeenCalledOnce();
        expect(document.querySelector('[data-testid="connection-modal"]')).toBeNull();
        expect(bodyText()).toContain('Провайдер сохранён. Теперь введите ваш личный ключ.');
        expect(document.querySelector('[data-testid="personal-key"]')).not.toBeNull();
    });

    it('checks the connection of an unverified ollama model and refreshes the catalog', async () => {
        const onRefresh = vi.fn();
        const target = model({ runtime: 'ollama' });
        await render({ items: [target], assigned: new Set(['m1']), canAssign: true, canCheck: true, onRefresh });
        const action = button('Проверить подключение');
        expect(action).toBeDefined();
        await click(action!);
        expect(apiMock.operate).toHaveBeenCalledOnce();
        expect(apiMock.operate).toHaveBeenCalledWith(target, 'check');
        expect(onRefresh).toHaveBeenCalledOnce();
    });

    it('shows the server reason when the check operation itself fails', async () => {
        const onRefresh = vi.fn();
        apiMock.operate.mockResolvedValueOnce({
            state: 'error',
            message: '',
            checkedAt: null,
            operation: {
                id: 'op-1',
                action: 'check',
                state: 'failed',
                stage: 'probe',
                message: 'Провайдер недоступен',
                progress: null,
                startedAt: '',
                finishedAt: '',
            },
        });
        await render({ items: [model()], assigned: new Set(['m1']), canCheck: true, onRefresh });
        await click(button('Проверить подключение')!);
        expect(bodyText()).toContain('Провайдер недоступен');
        expect(onRefresh).toHaveBeenCalledOnce();
        expect(button('Проверить подключение')?.disabled).toBe(false);
    });

    it('explains the ollama gap to a role that cannot check', async () => {
        await render({
            items: [model({ runtime: 'ollama' })],
            assigned: new Set(['m1']),
            canAssign: true,
            canCheck: false,
        });
        expect(button('Проверить подключение')).toBeUndefined();
        expect(bodyText()).toContain('Проверить модель на сервере может главный администратор.');
    });

    it('reports a failed check without touching the catalog', async () => {
        const onRefresh = vi.fn();
        // Без собственного текста ошибки errorMessage показывает fallback панели.
        apiMock.operate.mockRejectedValueOnce(new Error(''));
        await render({ items: [model({ runtime: 'ollama' })], assigned: new Set(['m1']), canCheck: true, onRefresh });
        await click(button('Проверить подключение')!);
        expect(onRefresh).not.toHaveBeenCalled();
        expect(bodyText()).toContain('Проверка подключения не удалась.');
        // busy state cleared: the action can be retried.
        expect(button('Проверить подключение')?.disabled).toBe(false);
    });

    it('keeps the connection modal open when the provider save fails', async () => {
        const onRefresh = vi.fn(() => {
            throw new Error('offline');
        });
        await render({
            items: [model()],
            assigned: new Set(['m1']),
            canAssign: true,
            canCheck: true,
            canConfigure: true,
            onRefresh,
        });
        await click(button('Настроить провайдера и ключ')!);
        await click(button('Изменить адрес и настройки провайдера')!);
        await click(document.querySelector('[data-testid="connection-save"]')!);
        // onRefresh rejected inside onSaved: the modal reports the error and stays open.
        expect(document.querySelector('[data-testid="connection-modal"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="connection-error"]')).not.toBeNull();
    });

    it('explains an empty catalog instead of rendering rows', async () => {
        await render({ items: [], canAssign: true });
        expect(bodyText()).toContain('В каталоге нет моделей, которые можно добавить в этот проект для чата.');
        expect(button('Добавить в проект')).toBeUndefined();
    });
});
