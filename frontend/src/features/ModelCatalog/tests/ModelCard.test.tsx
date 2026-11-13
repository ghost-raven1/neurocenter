// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelCard } from '../ModelCard';
import type { ICatalogModel } from '../interfaces';

vi.mock('../ModelHosting', () => ({ ModelHosting: () => null }));
const model: ICatalogModel = {
    id: 'remote-model',
    name: 'Remote',
    description: '',
    capability: 'chat',
    runtime: 'remote-openai',
    model: 'remote',
    manifestSha256: null,
    dimension: null,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
it.each([false, true])('opens provider details directly from the card when canHost=%s', async (canHost) => {
    const onView = vi.fn(),
        onAssign = vi.fn(),
        onConfigure = vi.fn();
    await act(async () =>
        root.render(
            <ModelCard
                model={model}
                assigned={false}
                projectSelected={false}
                canAssign={false}
                canHost={canHost}
                busy={false}
                onView={onView}
                onAssign={onAssign}
                onConfigure={onConfigure}
            />,
        ),
    );
    const action = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Настроить «Мой доступ»',
    );
    expect(action).toBeDefined();
    expect(action!.closest('details')).toBeNull();
    await act(async () => action!.click());
    expect(onView).toHaveBeenCalledOnce();
    expect(onAssign).not.toHaveBeenCalled();
    expect(onConfigure).not.toHaveBeenCalled();
});
it('opens provider access setup from the card when onProviderAccess is provided', async () => {
    const onView = vi.fn(),
        onAssign = vi.fn(),
        onProviderAccess = vi.fn();
    await act(async () =>
        root.render(
            <ModelCard
                model={model}
                assigned={false}
                projectSelected={false}
                canAssign={false}
                canHost={false}
                busy={false}
                onView={onView}
                onAssign={onAssign}
                onProviderAccess={onProviderAccess}
            />,
        ),
    );
    const action = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Настроить «Мой доступ»',
    );
    expect(action).toBeDefined();
    expect(action!.closest('details')).toBeNull();
    await act(async () => action!.click());
    expect(onProviderAccess).toHaveBeenCalledOnce();
    expect(onView).not.toHaveBeenCalled();
    expect(onAssign).not.toHaveBeenCalled();
});
it.each([
    ['unknown', true],
    ['connected', false],
    ['checking', false],
    [undefined, false],
] as Array<['checking' | 'unknown' | 'connected' | undefined, boolean]>)(
    'shows a sibling connection check when the status is unverified (status=%s, expect check=%s)',
    async (connectionStatus, expectCheck) => {
        const onCheckConnection = vi.fn();
        await act(async () =>
            root.render(
                <ModelCard
                    model={{
                        ...model,
                        capability: 'embedding',
                        dimension: 1536,
                        modelVersion: '1',
                        verificationSha256: 'a'.repeat(64),
                    }}
                    assigned
                    projectSelected
                    canAssign
                    canHost={false}
                    busy={false}
                    connectionStatus={connectionStatus}
                    onCheckConnection={onCheckConnection}
                    onAssign={vi.fn()}
                    onConnect={vi.fn()}
                    onView={vi.fn()}
                />,
            ),
        );
        const check = [...container.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === 'Проверить подключение',
        );
        if (expectCheck) {
            expect(check).toBeDefined();
            await act(async () => check!.click());
            expect(onCheckConnection).toHaveBeenCalledOnce();
        } else {
            expect(check).toBeUndefined();
        }
    },
);
it('does not show remote provider setup on a local model', async () => {
    await act(async () =>
        root.render(
            <ModelCard
                model={{ ...model, runtime: 'ollama' }}
                assigned={false}
                projectSelected={false}
                canAssign={false}
                canHost={false}
                busy={false}
                onView={vi.fn()}
                onAssign={vi.fn()}
            />,
        ),
    );
    expect(
        [...container.querySelectorAll('button')].some(
            (button) => button.textContent?.trim() === 'Настроить «Мой доступ»',
        ),
    ).toBe(false);
});
