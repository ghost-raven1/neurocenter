// @vitest-environment jsdom
import { act } from 'react';
import { webcrypto } from 'node:crypto';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { cliRequestFingerprint } from '../../ComputerSetup/hooks/receipt';
import { KnowledgeSync } from '../KnowledgeSync';
import { stubModalBrowser } from '../../ModelCatalog/tests/browser.fixture';

const io = vi.hoisted(() => ({ create: vi.fn(), receipt: vi.fn(), email: 'qa@example.test', binding: 'a' }));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({ userBlock: { user: { id: 'owner', email: io.email, activeRole: 'Главный админ' } } }),
}));
vi.mock('../api', () => ({ bridgeApi: { create: io.create, request: io.receipt } }));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'actor', captureOwner }) };
});
vi.mock('../../FeatureFlags/hooks/useFeatureAvailability', () => ({
    useFeatureAvailability: () => ({ enabled: true, known: true }),
}));
vi.mock('../ragUi/OpenCodeRagUi', () => ({ OpenCodeRagUi: () => null }));
vi.mock('../hooks/useBridge', () => ({
    useBridge: () => ({
        device: {
            id: 'device',
            name: 'QA computer',
            role: 'Главный админ',
            online: true,
            report: {
                protocolVersion: 2,
                root: '/qa',
                capabilities: ['durable-completions', 'managed-installations', 'project-rag-generations-v1'],
                bindings: ['project', 'other'].map((projectId) => ({
                    projectId,
                    bindingId: io.binding.repeat(64),
                    folderName: 'QA',
                })),
            },
        },
        jobs: [],
        jobsReady: true,
        devicesReady: true,
        loading: false,
        reload: async () => undefined,
    }),
}));

/** Unknown POST acknowledgement must keep one request identity across retry and remount. */
it.each([
    'remount',
    'different project',
    'different owner',
    'different binding',
    'storage failure',
    'receipt unavailable',
    'accepted receipt',
    'terminal receipt',
])('%s preserves durable request ownership', async (scenario) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    localStorage.clear();
    io.email = 'qa@example.test';
    io.binding = 'a';
    vi.stubGlobal('crypto', webcrypto);
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
            request: async (_key: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
    });
    io.receipt.mockRejectedValue({ response: { status: 404 } });
    io.create.mockReset();
    io.receipt.mockReset();
    io.receipt.mockRejectedValue({ response: { status: 404 } });
    if (scenario === 'storage failure')
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw Error('Хранилище недоступно');
        });
    io.create.mockRejectedValue(new Error('Подтверждение потеряно'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const show = async (visible: boolean, projectId = 'project') => {
        await act(async () =>
            root.render(<MemoryRouter>{visible && <KnowledgeSync projectId={projectId} canWrite />}</MemoryRouter>),
        );
    };
    const submit = async () => {
        const button = Array.from(container.querySelectorAll('button')).find(
            (node) => node.textContent === 'Синхронизировать с сервером',
        );
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(false);
        await act(async () => button!.click());
    };
    try {
        await show(true);
        await submit();
        if (scenario === 'storage failure') {
            expect(io.create).not.toHaveBeenCalled();
            expect(container.textContent).toContain('Хранилище недоступно');
            return;
        }
        expect(container.textContent).toContain('Подтверждение потеряно');
        if (scenario === 'terminal receipt') {
            const request = io.create.mock.calls[0][0];
            io.receipt.mockResolvedValue({
                requestKey: request.requestKey,
                requestFingerprint: await cliRequestFingerprint({ role: 'Главный админ', request }),
                job: {
                    id: 'done',
                    deviceId: 'device',
                    projectId: 'project',
                    bindingId: 'a'.repeat(64),
                    kind: 'sync-rag',
                    state: 'succeeded',
                    message: 'Синхронизировано',
                },
            });
            await submit();
            for (
                let attempt = 0;
                attempt < 20 && !container.textContent?.includes('Предыдущая операция завершена');
                attempt++
            )
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                });
            expect(io.create).toHaveBeenCalledTimes(1);
            expect(container.textContent).toContain('Предыдущая операция завершена; можно запустить снова.');
            return;
        }
        await submit();
        expect(io.create).toHaveBeenCalledTimes(2);
        expect(io.create.mock.calls[1][0]).toEqual(io.create.mock.calls[0][0]);
        await show(false);
        if (scenario === 'different owner') io.email = 'other@example.test';
        if (scenario === 'different binding') io.binding = 'b';
        if (scenario === 'receipt unavailable') io.receipt.mockRejectedValue(Error('Квитанция недоступна'));
        if (scenario === 'accepted receipt') {
            const request = io.create.mock.calls[0][0];
            io.receipt.mockResolvedValue({
                requestKey: request.requestKey,
                requestFingerprint: await cliRequestFingerprint({ role: 'Главный админ', request }),
                job: {
                    id: 'accepted-job',
                    deviceId: 'device',
                    projectId: 'project',
                    bindingId: 'a'.repeat(64),
                    kind: 'sync-rag',
                    state: 'queued',
                    message: 'Принято сервером',
                },
            });
        }
        await show(true, scenario === 'different project' ? 'other' : 'project');
        if (scenario === 'accepted receipt') {
            for (let attempt = 0; attempt < 20 && !container.textContent?.includes('Принято сервером'); attempt++)
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                });
            expect(container.textContent).toContain('Принято сервером');
            const button = Array.from(container.querySelectorAll('button')).find(
                (node) => node.textContent === 'Синхронизировать с сервером',
            );
            expect(button!.disabled).toBe(true);
            expect(io.create).toHaveBeenCalledTimes(2);
            return;
        }
        await submit();
        if (scenario === 'receipt unavailable') {
            expect(io.create).toHaveBeenCalledTimes(2);
            expect(container.textContent).toContain('Квитанция недоступна');
            return;
        }
        expect(io.create).toHaveBeenCalledTimes(3);
        if (scenario === 'different owner' || scenario === 'different binding') {
            expect(io.create.mock.calls[2][0].requestKey).not.toBe(io.create.mock.calls[0][0].requestKey);
        } else if (scenario === 'different project') {
            expect(io.create.mock.calls[2][0].projectId).toBe('other');
            expect(io.create.mock.calls[2][0].requestKey).not.toBe(io.create.mock.calls[0][0].requestKey);
        } else expect(io.create.mock.calls[2][0]).toEqual(io.create.mock.calls[0][0]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});
