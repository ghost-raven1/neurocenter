// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { RemoteProviderAccess } from '../../RemoteProviderAccess';
import { stubModalBrowser } from '../../../ModelCatalog/tests/browser.fixture';
import { cliRequestFingerprint } from '../../../ComputerSetup/hooks/receipt';
const io = vi.hoisted(() => ({
    open: vi.fn(),
    request: vi.fn(),
    receipt: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    manualReceipt: vi.fn(),
    enabled: true,
    capable: true,
    role: 'Разработчик',
}));
vi.mock('../api', () => ({ localKeyTransferApi: { open: io.open, request: io.request, receipt: io.receipt } }));
vi.mock('../../api', () => ({ personalProviderApi: { read: io.read, write: io.write, receipt: io.manualReceipt } }));
vi.mock('../../../../core/api/base', () => ({ default: { defaults: { baseURL: 'https://hub.example.test' } } }));
vi.mock('../../../../core/api', () => ({ baseApi: { defaults: { baseURL: 'https://hub.example.test' } } }));
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
vi.mock('../../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
vi.mock('../../../FeatureFlags/FeatureAvailability', () => ({
    useFeatureAvailability: (...keys: string[]) => ({
        enabled: !keys.includes('opencode_personal_key_transfer') || io.enabled,
        reason: 'Функция выключена',
    }),
}));
vi.mock('../../../ComputerSetup/journalLock', () => ({
    browserCliJournalLock: () => async (_key: string, work: () => unknown) => work(),
}));
vi.mock('../../../McpBridge/hooks/useBridge', () => ({
    useBridge: () => {
        const device = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Computer',
            online: true,
            role: 'Разработчик',
            report: { capabilities: io.capable ? ['opencode-personal-key-v1'] : [] },
        };
        return { device, devices: [device], devicesReady: true, errors: {}, choose: vi.fn(), reload: vi.fn() };
    },
}));
const view = {
    modelId: 'model',
    providerId: 'a'.repeat(64),
    providerUrl: 'https://api.openai.com/v1',
    connectionRevision: 1,
    credentialRevision: 0,
    authMode: 'required',
    canStoreKey: true,
    hasKey: false,
    updatedAt: null,
    legacySharedKeyRetained: false,
};
const job = {
    id: '22222222-2222-4222-8222-222222222222',
    deviceId: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    kind: 'open-opencode-personal-key',
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
    vi.clearAllMocks();
    io.enabled = true;
    io.capable = true;
    io.role = 'Разработчик';
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    localStorage.clear();
    io.read.mockResolvedValue(view);
    io.open.mockResolvedValue(job);
    io.receipt.mockResolvedValue({ receipt: null, canStartNew: false });
    io.request.mockImplementation(async () => {
        const request = io.open.mock.calls[0][0];
        return {
            requestKey: request.requestKey,
            requestFingerprint: await cliRequestFingerprint({ role: io.role, request }),
            job,
        };
    });
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
async function render() {
    await act(async () => root.render(<RemoteProviderAccess modelId="model" />));
}
function button(label: string) {
    const found = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes(label));
    expect(found).toBeDefined();
    return found!;
}
async function click(label: string) {
    await act(async () => button(label).click());
}
async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
    });
}
it('opens recipient preview without a POST and preserves manual input during receipt recovery', async () => {
    await render();
    const input = document.querySelector('input')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'manual-draft-secret');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Использовать ключ OpenCode');
    expect(io.open).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('1.14.48');
    expect(document.body.textContent).toContain('owner@example.test');
    await click('Открыть приватное окно');
    await settle();
    expect(io.open).toHaveBeenCalledTimes(1);
    const request = io.open.mock.calls[0][0];
    io.receipt.mockResolvedValue({
        canStartNew: true,
        receipt: {
            schemaVersion: 1,
            jobId: job.id,
            requestKey: request.requestKey,
            modelId: 'model',
            providerId: view.providerId,
            connectionRevision: 1,
            credentialRevision: 1,
            hasKey: true,
            acceptedAt: '2026-11-01T00:00:00.000Z',
        },
    });
    await click('Проверить передачу');
    await settle();
    expect(document.body.textContent).toContain('Сохранение личного ключа подтверждено');
    expect(input.value).toBe('manual-draft-secret');
    expect(JSON.stringify(localStorage)).not.toContain('manual-draft-secret');
    expect(io.write).not.toHaveBeenCalled();
});
it('OFF keeps accepted receipt readable and disables any new transfer', async () => {
    await render();
    await click('Использовать ключ OpenCode');
    await click('Открыть приватное окно');
    await settle();
    io.enabled = false;
    await render();
    await click('Проверить передачу');
    await settle();
    expect(io.receipt.mock.calls.length).toBeGreaterThan(1);
    expect(io.open).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Функция выключена');
});
it('missing capability cannot authorize OPEN', async () => {
    io.capable = false;
    await render();
    await click('Использовать ключ OpenCode');
    expect(button('Открыть приватное окно').disabled).toBe(true);
    expect(io.open).not.toHaveBeenCalled();
});
it('renders for a non-OpenAI provider URL and shows the actual recipient address', async () => {
    io.read.mockResolvedValue({ ...view, providerUrl: 'https://gateway.example.test/v1' });
    await render();
    await click('Использовать ключ OpenCode');
    expect(document.body.textContent).toContain('API провайдера: https://gateway.example.test/v1');
});
