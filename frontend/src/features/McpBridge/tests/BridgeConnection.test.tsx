// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { it, expect, vi } from 'vitest';
import { BridgeConnection } from '../BridgeConnection';
import type { useBridge } from '../hooks/useBridge';
import { unifiedSetupStep } from '../../../modules/Start/projectSetupModel';
import { stubModalBrowser } from '../../ModelCatalog/tests/browser.fixture';
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
it.each(['connect', 'add'])('%s computer starts bridge onboarding while retaining the project', async (action) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
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
        devices: [],
        devicesReady: true,
        errors: {},
        loading: false,
        choose: vi.fn(),
        reload: vi.fn(),
    } as unknown as ReturnType<typeof useBridge>;
    const click = async (text: string) => {
        const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === text);
        expect(button).toBeDefined();
        await act(async () => button!.click());
    };
    try {
        await act(async () =>
            root.render(
                <MemoryRouter initialEntries={['/store?p=prj-owned']}>
                    <Location />
                    <BridgeConnection bridge={bridge} projectId="prj-owned" />
                </MemoryRouter>,
            ),
        );
        if (action === 'add') {
            await click('Мои компьютеры (0)');
            const connect = Array.from(document.querySelectorAll('[role=dialog] button')).find(
                (node) => node.textContent === 'Подключить компьютер',
            ) as HTMLButtonElement;
            expect(connect).toBeDefined();
            await act(async () => connect.click());
        } else await click('Подключить компьютер');
        const url = new URL(destination, 'http://test');
        expect(url.searchParams.get('p')).toBe('prj-owned');
        expect(unifiedSetupStep(url.search)).toBe(0);
        expect(url.searchParams.get('addComputer')).toBe(action === 'add' ? '1' : null);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});
