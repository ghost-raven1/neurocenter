// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { it, expect, vi } from 'vitest';
import { BridgeSourceSettings } from '../BridgeSourceSettings';
import { unifiedSetupStep } from '../../Start/projectSetupModel';
vi.mock('../hooks/useBridgeSourceDraft', () => ({ useBridgeSourceDraft: () => ({ data: { sourceMode: 'offline' } }) }));
it('installation link opens bridge onboarding rather than the OpenCode step', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () =>
            root.render(
                <MemoryRouter>
                    <BridgeSourceSettings />
                </MemoryRouter>,
            ),
        );
        const link = Array.from(container.querySelectorAll('a')).find((node) => node.textContent === '«Начало работы»');
        expect(link).toBeDefined();
        const target = new URL(link!.getAttribute('href')!, 'http://test');
        expect(target.pathname).toBe('/start');
        expect(target.searchParams.get('setup')).toBe('1');
        expect(unifiedSetupStep(target.search)).toBe(0);
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});
