// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { it, expect, vi } from 'vitest';
import { ProjectInstallationReadiness } from '../ProjectInstallationReadiness';
import type { useBridge } from '../hooks/useBridge';
import { unifiedSetupStep } from '../../../modules/Start/projectSetupModel';
vi.mock('../readiness', () => ({ connectionBlocker: () => '' }));
it('folder action opens the folder stage for the exact project, not bridge onboarding', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let destination = '';
    function Location() {
        const location = useLocation();
        destination = location.pathname + location.search;
        return null;
    }
    const bridge = {
        devicesReady: true,
        jobsReady: true,
        installationsReady: true,
        device: { id: 'qa-computer', online: true, report: { bindings: [] } },
    } as unknown as ReturnType<typeof useBridge>;
    try {
        await act(async () =>
            root.render(
                <MemoryRouter initialEntries={['/store?p=prj-owned']}>
                    <Location />
                    <ProjectInstallationReadiness bridge={bridge} projectId="prj-owned" canInstall />
                </MemoryRouter>,
            ),
        );
        const action = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Выбрать папку проекта',
        )!;
        expect(action).toBeDefined();
        await act(async () => action.click());
        const url = new URL(destination, 'http://test');
        expect(url.pathname).toBe('/start');
        expect(url.searchParams.get('p')).toBe('prj-owned');
        expect(url.searchParams.get('setup')).toBe('1');
        expect(unifiedSetupStep(url.search)).toBe(3);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});

it('opens the binding on the spot through onChooseFolder without leaving the page', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const chooseFolder = vi.fn();
    let destination = '';
    function Location() {
        const location = useLocation();
        destination = location.pathname + location.search;
        return null;
    }
    const bridge = {
        devicesReady: true,
        jobsReady: true,
        installationsReady: true,
        device: { id: 'qa-computer', online: true, report: { bindings: [] } },
    } as unknown as ReturnType<typeof useBridge>;
    try {
        await act(async () =>
            root.render(
                <MemoryRouter initialEntries={['/store?p=prj-owned']}>
                    <Location />
                    <ProjectInstallationReadiness bridge={bridge} projectId="prj-owned" canInstall onChooseFolder={chooseFolder} />
                </MemoryRouter>,
            ),
        );
        const action = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Выбрать папку проекта',
        )!;
        await act(async () => action.click());
        expect(chooseFolder).toHaveBeenCalledTimes(1);
        // Перехода на /start не было: остаёмся на странице каталога.
        expect(destination).toBe('/store?p=prj-owned');
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});
