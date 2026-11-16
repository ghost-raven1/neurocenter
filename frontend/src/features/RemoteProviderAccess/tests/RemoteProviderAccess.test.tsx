// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { RemoteProviderAccess } from '../RemoteProviderAccess';

const io = vi.hoisted(() => ({
    read: vi.fn(),
    write: vi.fn(),
    receipt: vi.fn(),
    role: 'Разработчик',
}));
vi.mock('../api', () => ({ personalProviderApi: { read: io.read, write: io.write, receipt: io.receipt } }));
vi.mock('../../../core/api/base', () => ({ default: { defaults: { baseURL: 'https://hub.example.test' } } }));
vi.mock('../../../core/api', () => ({ baseApi: { defaults: { baseURL: 'https://hub.example.test' } } }));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({
            userBlock: {
                user: {
                    id: 'owner',
                    principalName: 'owner',
                    email: 'owner@example.test',
                    activeRole: io.role,
                    userRoles: [io.role],
                },
            },
        }),
}));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
vi.mock('../../FeatureFlags/FeatureAvailability', () => ({
    useFeatureAvailability: () => ({ enabled: true, reason: '' }),
}));
vi.mock('../../../McpBridge/hooks/useBridge', () => ({
    useBridge: () => ({
        device: undefined,
        devices: [],
        devicesReady: true,
        errors: {},
        choose: vi.fn(),
        reload: vi.fn(),
    }),
}));

const view = {
    modelId: 'model',
    providerId: 'a'.repeat(64),
    providerUrl: 'https://api.example.test/v1',
    connectionRevision: 1,
    credentialRevision: 0,
    authMode: 'required',
    canStoreKey: true,
    hasKey: false,
    updatedAt: null,
    legacySharedKeyRetained: false,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    localStorage.clear();
    io.read.mockResolvedValue(view);
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
async function render(overrides: Partial<typeof view> = {}): Promise<void> {
    io.read.mockResolvedValue({ ...view, ...overrides });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        root.render(<RemoteProviderAccess modelId="model" />);
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
    });
}
it('один раздел ключа: личный ключ, перенос с компьютера и legacy-пометка старого общего ключа', async () => {
    await render({ legacySharedKeyRetained: true });
    const text = container.textContent ?? '';
    expect(text).toContain('Мой доступ');
    expect(text).toContain('Личный ключ');
    expect(text).toContain('Перенос с компьютера');
    // legacy — только отметка (без действий), с бейджем «старый общий ключ».
    expect(text).toContain('Старый общий ключ');
    expect(text).toContain('legacy');
    expect(container.querySelector('input')).not.toBeNull();
    const buttons = [...container.querySelectorAll('button')].map((node) => node.textContent ?? '');
    expect(buttons.some((label) => label.includes('Использовать ключ OpenCode'))).toBe(true);
});
it('без сохранённого старого ключа legacy-раздел не показывается', async () => {
    await render();
    const text = container.textContent ?? '';
    expect(text).not.toContain('Старый общий ключ');
    expect(text).toContain('Личный ключ');
});
