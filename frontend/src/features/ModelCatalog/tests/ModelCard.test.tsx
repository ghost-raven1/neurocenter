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
        (button) => button.textContent?.trim() === 'Провайдер и API-ключ',
    );
    expect(action).toBeDefined();
    expect(action!.closest('details')).toBeNull();
    await act(async () => action!.click());
    expect(onView).toHaveBeenCalledOnce();
    expect(onAssign).not.toHaveBeenCalled();
    expect(onConfigure).not.toHaveBeenCalled();
});
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
            (button) => button.textContent?.trim() === 'Провайдер и API-ключ',
        ),
    ).toBe(false);
});
