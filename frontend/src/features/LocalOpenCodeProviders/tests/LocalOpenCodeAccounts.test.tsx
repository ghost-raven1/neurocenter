// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
    OPENCODE_V2_ACCOUNTS_ADAPTER as ADAPTER,
    OPENCODE_V2_ACCOUNTS_CAPABILITY as CAPABILITY,
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as OPEN,
} from '@neurocenter/opencode-local-providers';
import { LocalOpenCodeProvidersStep } from '../LocalOpenCodeProvidersStep';
import type { useBridge } from '../../McpBridge/hooks/useBridge';
const io = vi.hoisted(() => ({
    list: vi.fn(),
    request: vi.fn(),
    create: vi.fn(),
    cancel: vi.fn(),
    enabled: true,
    role: 'Разработчик',
}));
vi.mock('../api', () => ({ localProvidersApi: io }));
vi.mock('../../../core/api/base', () => ({ default: { defaults: { baseURL: 'https://example.test' } } }));
vi.mock('react-redux', () => ({
    useSelector: (select: (value: unknown) => unknown) =>
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
    useFeatureAvailability: (...keys: string[]) => ({
        enabled: !keys.includes('opencode_v2_accounts') || io.enabled,
        known: true,
        reason: 'Функция выключена',
    }),
}));
vi.mock('../../ComputerSetup/journalLock', () => ({
    browserCliJournalLock: () => async (_key: string, work: () => unknown) => work(),
}));
const deviceId = '11111111-1111-4111-8111-111111111111',
    jobId = '33333333-3333-4333-8333-333333333333';
const time = '2026-11-01T00:00:00.000Z';
function history() {
    return [
        {
            id: jobId,
            deviceId,
            projectId: null,
            kind: READ,
            adapter: ADAPTER,
            state: 'succeeded',
            createdAt: time,
            updatedAt: time,
            result: {
                schemaVersion: 1,
                scope: 'global',
                deviceId,
                jobId,
                kind: READ,
                adapter: ADAPTER,
                checkedAt: time,
                status: 'checked',
                accountInventory: {
                    accounts: [{ integrationId: 'anthropic', hasApiKey: true, hasOAuth: false, hasExternal: false }],
                    issues: [],
                },
            },
        },
    ];
}
let root: Root, container: HTMLDivElement;
const next = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    io.enabled = true;
    io.role = 'Разработчик';
    io.list.mockResolvedValue(history());
    io.create.mockRejectedValue(new Error('Lost ACK'));
    io.request.mockRejectedValue({ response: { status: 404 } });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => '22222222-2222-4222-8222-222222222222' });
    vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
    );
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
async function render(version = '2.2.2', capabilities = [CAPABILITY, 'opencode-global-providers-v1']): Promise<void> {
    const bridge = {
        device: { id: deviceId, online: true, role: io.role, requiresReconnect: false, report: { capabilities } },
        devicesReady: true,
        errors: {},
    } as unknown as ReturnType<typeof useBridge>;
    await act(async () =>
        root.render(<LocalOpenCodeProvidersStep bridge={bridge} enabled cliVersion={version} onContinue={next} />),
    );
}
function button(label: string): HTMLButtonElement {
    const value = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    expect(value, label).toBeDefined();
    return value!;
}
it('shows only stored account metadata and opens the V2 add-account workflow explicitly', async () => {
    await render();
    expect(container.textContent).toContain('Учётные записи OpenCode 2');
    expect(container.textContent).toContain('anthropic');
    expect(container.textContent).toContain('не подтверждает готовность провайдера');
    expect(io.create).not.toHaveBeenCalled();
    await act(async () => button('Добавить учётную запись Anthropic').click());
    expect(io.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: OPEN, adapter: ADAPTER, scope: 'global' }),
        expect.any(AbortSignal),
    );
});
it('allows history and reread while the V2 creation flag is off', async () => {
    io.enabled = false;
    await render();
    expect(container.textContent).toContain('anthropic');
    expect(button('Добавить учётную запись Anthropic').disabled).toBe(true);
    expect(button('Перечитать учётные записи').disabled).toBe(false);
    await act(async () => button('Перечитать учётные записи').click());
    expect(io.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: READ, adapter: ADAPTER }),
        expect.any(AbortSignal),
    );
});
it('requires the V2 capability and does not treat another CLI version as supported V2', async () => {
    await render('2.2.2', ['opencode-global-providers-v1']);
    expect(button('Добавить учётную запись Anthropic').disabled).toBe(true);
    expect(button('Перечитать учётные записи').disabled).toBe(true);
    await render('2.2.1');
    expect(container.textContent).toContain('Файлы прежнего формата');
    expect(button('Настроить на компьютере').disabled).toBe(true);
    expect(container.textContent).not.toContain('anthropic');
});
it('keeps observer history readable without permitting account creation', async () => {
    io.role = 'Наблюдатель';
    await render();
    expect(container.textContent).toContain('anthropic');
    expect(button('Добавить учётную запись Anthropic').disabled).toBe(true);
    expect(io.create).not.toHaveBeenCalled();
});
it('ignores a late V2 history response after switching back to V1 mode', async () => {
    let resolve!: (value: unknown) => void;
    io.list.mockImplementationOnce(
        () =>
            new Promise((done) => {
                resolve = done;
            }),
    );
    await render();
    io.list.mockResolvedValue([]);
    await render('1.14.48');
    await act(async () => {
        resolve(history());
    });
    expect(container.textContent).not.toContain('anthropic');
    expect(container.textContent).not.toContain('Учётные записи OpenCode 2');
    expect(io.create.mock.calls.every((call) => call[0].adapter === undefined)).toBe(true);
});

it('blocks continuation and account creation when the server denies history access', async () => {
    io.list.mockRejectedValue({ response: { status: 403 } });
    await render();
    expect(button('Продолжить настройку OpenCode').disabled).toBe(true);
    expect(button('Добавить учётную запись Anthropic').disabled).toBe(true);
    expect(io.create).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
});
