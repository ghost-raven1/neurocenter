// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeModelSyncSettings } from '../OpenCodeModelSyncSettings';
import { stubModalBrowser } from './browser.fixture';

const api = vi.hoisted(() => ({
    get: async () => ({ data: null }),
    put: async () => ({ data: null }),
}));
vi.mock('../../../core/api/base', () => ({ default: api }));
const userState = vi.hoisted(() => ({ role: 'Главный админ' as string }));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({ userBlock: { user: { activeRole: userState.role } } }),
}));
const captureOwner = vi.hoisted(() => () => () => true);
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => ({
    useAuthRequestOwner: () => ({ scope: 'actor', captureOwner }),
}));
vi.mock('../../FeatureFlags/FeatureAvailability', async () => {
    const { Button } = await import('antd');
    return {
        useFeatureAvailability: () => ({ enabled: true, reason: '', refresh: () => undefined }),
        FeatureButton: ({ features: _features, ...props }: import('antd').ButtonProps & { features: string[] }) => (
            <Button {...props} />
        ),
        FeatureAvailabilityNotice: () => null,
    };
});

const settings = {
    revision: 1,
    enabled: true,
    transferCredentials: false,
    canTransferCredentials: false,
    sources: [
        {
            scope: 'global',
            projectId: null,
            projectName: null,
            provider: 'openai',
            configKey: 'openai',
            modelId: 'model-1',
            name: 'QA model',
            state: 'present',
            credentialStatus: 'pending',
            contextWindow: null,
            outputTokenLimit: null,
            assigned: false,
            needsCheck: true,
            hasServerKey: false,
            revoked: false,
            archivedAt: null,
        },
    ],
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    userState.role = 'Главный админ';
    api.get = vi.fn(async () => ({ data: settings }));
    api.put = vi.fn(async () => ({ data: settings }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('OpenCodeModelSyncSettings: устройство — только автосинхронизация', () => {
    it('не предлагает настроить подключение из списка источников', async () => {
        await act(async () => root.render(<OpenCodeModelSyncSettings deviceId="device-1" supported />));
        const open = Array.from(container.querySelectorAll('button')).find(
            (node) => node.textContent === 'Модели OpenCode',
        )!;
        await act(async () => {
            open.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        // Модал antd открывается порталом в document.body.
        expect(document.body.textContent).toContain('QA model');
        // Дубли карточки модели убран: вложенный модал подключения больше не открывается.
        expect(
            Array.from(document.body.querySelectorAll('button')).some((node) => node.textContent === 'Подключение'),
        ).toBe(false);
        expect(document.body.textContent).not.toContain('Подключение · «');
        // Проверка API и автосинхронизация остаются на странице устройства.
        expect(
            Array.from(document.body.querySelectorAll('button')).some((node) => node.textContent === 'Проверить'),
        ).toBe(true);
        expect(document.body.querySelector('[aria-label="Автоматически добавлять модели OpenCode"]')).not.toBeNull();
    });
});
