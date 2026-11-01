// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Switch, useHistory } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { AssetsEntry } from '../AssetsEntry';
import AssetSources from '../../../features/AssetSources/AssetSources';
import { FeatureAvailabilityContext } from '../../../features/FeatureFlags/context';
import { featureDefinitions } from '../../../features/FeatureFlags/constants';
import type { IEvaluatedFeatureFlags } from '../../../features/FeatureFlags/interfaces';
import type { IAvailabilityContext } from '../../../features/FeatureFlags/context.interfaces';
import { stubModalBrowser } from '../../../features/ModelCatalog/tests/browser.fixture';
const io = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../core/api', () => ({ baseApi: io, bffApi: {} }));
vi.mock('react-redux', () => ({
    useSelector: (select: (value: unknown) => unknown) =>
        select({
            userBlock: {
                user: {
                    id: 'owner',
                    principalName: 'owner',
                    activeRole: 'Главный админ',
                    userRoles: ['Главный админ'],
                    routePermissions: ['assets', 'store'],
                    projectRoles: [],
                },
                policies: [],
            },
        }),
}));
vi.mock('../../../features/UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
vi.mock('../../../core/socket/hooks/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../../../features/AssetSources/BundledCatalogSources', () => ({ BundledCatalogSources: () => null }));
vi.mock('../../../features/Catalog/StoreEditModal', () => ({ default: () => null }));
let root: Root, container: HTMLDivElement, history: ReturnType<typeof useHistory>;
const refresh = vi.fn(async () => undefined);
function Probe(): null {
    history = useHistory();
    return null;
}
function render(availability: IAvailabilityContext) {
    root.render(
        <FeatureAvailabilityContext.Provider value={availability}>
            <MemoryRouter initialEntries={['/assets?archive=open&qa=preserve#qa-anchor']}>
                <Probe />
                <Switch>
                    <Route path="/assets">
                        <AssetsEntry />
                    </Route>
                    <Route path="/store">
                        <AssetSources embedded />
                    </Route>
                </Switch>
            </MemoryRouter>
        </FeatureAvailabilityContext.Provider>,
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    localStorage.clear();
    io.get.mockResolvedValue({
        data: {
            source: { repository: 'bundled', mode: 'bundled', verified: true },
            assets: [],
            localAssets: [],
            sourcePlans: [],
        },
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
it.each([true, false])(
    'retains archive intent through deferred navigation flags and opens at the final destination (ON=%s)',
    async (enabled) => {
        const pending: IAvailabilityContext = { data: null, loading: true, error: null, refresh };
        await act(async () => render(pending));
        expect(history.location.pathname).toBe('/assets');
        expect(history.location.search).toBe('?archive=open&qa=preserve');
        expect(document.querySelector('[role=dialog]')).toBeNull();
        expect(io.get).not.toHaveBeenCalled();
        const flags = Object.fromEntries(
            featureDefinitions.map(({ key }) => [key, key === 'catalog_supplies_navigation' ? enabled : true]),
        ) as IEvaluatedFeatureFlags['flags'];
        const settled: IAvailabilityContext = {
            ...pending,
            loading: false,
            data: {
                flags,
                configured: flags,
                blockedBy: Object.fromEntries(
                    featureDefinitions.map(({ key }) => [key, [] as IEvaluatedFeatureFlags['blockedBy'][typeof key]]),
                ) as IEvaluatedFeatureFlags['blockedBy'],
            },
        };
        await act(async () => {
            await Promise.resolve();
            render(settled);
        });
        await vi.waitFor(() =>
            expect(document.querySelector('[role=dialog]')?.textContent).toContain('Импортировать архив'),
        );
        expect(history.location.pathname).toBe(enabled ? '/store' : '/assets');
        const query = new URLSearchParams(history.location.search);
        expect(query.get('archive')).toBeNull();
        expect(query.get('qa')).toBe('preserve');
        expect(history.location.hash).toBe('#qa-anchor');
        if (enabled) expect(query.get('tab')).toBe('supplies');
        expect(io.post).not.toHaveBeenCalled();
    },
);
