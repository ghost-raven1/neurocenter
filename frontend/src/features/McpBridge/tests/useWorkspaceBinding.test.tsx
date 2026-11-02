// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import { useWorkspaceBinding } from '../hooks/useWorkspaceBinding';
import type { useBridge } from '../hooks/useBridge';

vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => ({
    useAuthRequestOwner: () => ({ scope: 'u1', captureOwner: () => () => true }),
}));

const makeBridge = (): ReturnType<typeof useBridge> =>
    ({
        devicesReady: true,
        jobsReady: true,
        installationsReady: true,
        loading: false,
        error: '',
        errors: { devices: '', jobs: '', installations: '' },
        device: {
            id: 'qa-computer',
            online: true,
            role: 'Разработчик',
            requiresReconnect: false,
            report: {
                bindings: [],
                folders: ['proj'],
                root: '/work',
                protocolVersion: 2,
                capabilities: ['durable-completions', 'managed-installations', 'workspace-instance-v1'],
            },
        },
        jobs: [],
        installations: [],
        reload: () => {},
    }) as unknown as ReturnType<typeof useBridge>;

async function capture(canManage: boolean) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const bridge = makeBridge();
    let state: ReturnType<typeof useWorkspaceBinding> | undefined;
    function Probe() {
        state = useWorkspaceBinding({
            bridge,
            project: { id: 'prj-1', name: 'Проект' },
            canManage,
            onClose: () => {},
        });
        return null;
    }
    try {
        await act(async () => {
            root.render(<Probe />);
        });
        return state!;
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
}

it('blocks the binding only without the developer role, not because of a missing folder', async () => {
    const withoutRole = await capture(false);
    expect(withoutRole.blocker).toBe('Для привязки нужна роль разработчика в этом проекте.');
    const withRole = await capture(true);
    expect(withRole.blocker).toBe('');
});
