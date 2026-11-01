// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { BundledSourceCard } from '../BundledSourceCard';
import type { IBundledSourcePlan } from '../../interfaces';
import { FeatureAvailabilityContext } from '../../../FeatureFlags/context';
import { featureDefinitions } from '../../../FeatureFlags/constants';
import type { IEvaluatedFeatureFlags } from '../../../FeatureFlags/interfaces';
const plan: IBundledSourcePlan = {
    id: 'recipe',
    name: 'Recipe',
    description: 'Description',
    kind: 'mcp',
    delivery: 'prepared',
    sourceRevision: 'git-source-revision',
    revision: 'a'.repeat(64),
};
const imported = {
    id: 'catalog',
    name: 'Published title',
    version: 7,
    originVersion: 'old-source',
    updateAvailable: true,
};
let root: Root, container: HTMLDivElement;
const prepare = vi.fn(),
    archive = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
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
async function render(value = plan, options: { blocked?: boolean; locked?: boolean; enabled?: boolean } = {}) {
    const flags = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, options.enabled !== false]),
    ) as IEvaluatedFeatureFlags['flags'];
    const data: IEvaluatedFeatureFlags = {
        flags,
        configured: flags,
        blockedBy: Object.fromEntries(
            featureDefinitions.map(({ key }) => [key, [] as IEvaluatedFeatureFlags['blockedBy'][typeof key]]),
        ) as IEvaluatedFeatureFlags['blockedBy'],
    };
    await act(async () =>
        root.render(
            <FeatureAvailabilityContext.Provider
                value={{ data, loading: false, error: null, refresh: async () => undefined }}
            >
                <BundledSourceCard
                    plan={value}
                    blocked={!!options.blocked}
                    locked={!!options.locked}
                    onPrepare={prepare}
                    onImportArchive={archive}
                />
            </FeatureAvailabilityContext.Provider>,
        ),
    );
}
function button(label: string) {
    const value = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label);
    expect(value).toBeDefined();
    return value!;
}
it('separates source and published edition and opens only the selected current plan explicitly', async () => {
    await render({ ...plan, imported });
    expect(container.textContent).toContain('Исходники git-source-revision');
    expect(container.textContent).toContain('В каталоге: редакция 7 · old-source');
    expect(container.textContent).not.toContain('установлен');
    expect(prepare).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    const next = { ...plan, id: 'next', revision: 'b'.repeat(64), imported };
    await render(next);
    await act(async () => button('Подготовить обновление').click());
    expect(prepare).toHaveBeenCalledExactlyOnceWith(next);
});
it('published package takes priority over preparation and links to that catalog title', async () => {
    await render({ ...plan, catalogReady: true, imported });
    expect(container.textContent).toContain('Пакет этой версии опубликован');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/store?q=Published+title');
    expect(container.textContent).not.toContain('Подготовить');
    expect(prepare).not.toHaveBeenCalled();
});
it.each(['blocked', 'locked', 'archived', 'unavailable', 'flag-off'])(
    '%s keeps source visible but prevents preparation',
    async (reason) => {
        await render(
            {
                ...plan,
                imported: { ...imported, archived: reason === 'archived', unavailable: reason === 'unavailable' },
            },
            { blocked: reason === 'blocked', locked: reason === 'locked', enabled: reason !== 'flag-off' },
        );
        const action = button('Подготовить обновление');
        expect(action.disabled).toBe(true);
        await act(async () => action.click());
        expect(prepare).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Recipe');
    },
);
it.each(['prepared', 'local-project'])('%s new source offers explicit preparation', async (delivery) => {
    await render({ ...plan, delivery });
    await act(async () => button('Подготовить пакет').click());
    expect(prepare).toHaveBeenCalledTimes(1);
});
it('model and bridge fallback do not claim an install or offer a build', async () => {
    await render({ ...plan, kind: 'model', delivery: 'archive' });
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/store?tab=models');
    expect(container.textContent).toContain('Веса добавляются');
    await render({ ...plan, kind: 'bridge', delivery: 'archive' });
    expect(container.textContent).toContain('Архив моста создаётся');
    expect(container.querySelector('button')).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
});
it('archive fallback preserves its own lock semantics and requires an explicit enabled action', async () => {
    await render({ ...plan, delivery: 'archive' }, { locked: true });
    expect(archive).not.toHaveBeenCalled();
    await act(async () => button('Импортировать архив').click());
    expect(archive).toHaveBeenCalledTimes(1);
    await render({ ...plan, delivery: 'archive' }, { blocked: true });
    expect(button('Импортировать архив').disabled).toBe(true);
    await render({ ...plan, delivery: 'archive' }, { enabled: false });
    expect(button('Импортировать архив').disabled).toBe(true);
});
