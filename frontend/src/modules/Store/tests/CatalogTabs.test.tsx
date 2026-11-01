// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Switch, useHistory } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CatalogTabs } from '../CatalogTabs';
import { AssetsEntry } from '../../Assets/AssetsEntry';
import type { useBridge } from '../../../features/McpBridge/hooks/useBridge';
import { stubModalBrowser } from '../../../features/ModelCatalog/tests/browser.fixture';
const io = vi.hoisted(() => ({
    enabled: true,
    role: 'Главный админ',
    permissions: ['assets', 'store'],
    mounted: vi.fn(),
}));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({
            userBlock: {
                user: {
                    id: 'owner',
                    principalName: 'owner',
                    activeRole: io.role,
                    userRoles: [io.role],
                    routePermissions: io.permissions,
                    projectRoles: [],
                },
                policies: [],
            },
        }),
}));
vi.mock('../../../features/FeatureFlags/FeatureAvailability', () => ({
    useFeatureAvailability: () => ({ enabled: io.enabled, known: true }),
}));
vi.mock('../../../features/AssetSources/AssetSources', () => ({
    default: ({ embedded }: { embedded?: boolean }) => {
        io.mounted();
        return <div>{embedded ? 'Поставки общего каталога' : 'Прежний экран поставок'}</div>;
    },
}));
vi.mock('../../../features/ModelCatalog/ModelCatalog', () => ({ ModelCatalog: () => <div>Models</div> }));
vi.mock('../../../features/AgentCatalog/AgentCatalog/AgentCatalog', () => ({ AgentCatalog: () => <div>Agents</div> }));
vi.mock('../../../features/CatalogRequests/CatalogRequests', () => ({ CatalogRequests: () => <div>Requests</div> }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
    io.enabled = true;
    io.role = 'Главный админ';
    io.permissions = ['assets', 'store'];
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
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
async function render(url: string, embedded = false) {
    let history!: ReturnType<typeof useHistory>;
    function LocationProbe(): null {
        history = useHistory();
        return null;
    }
    await act(async () =>
        root.render(
            <MemoryRouter initialEntries={[url]}>
                <LocationProbe />
                <Switch>
                    <Route path="/assets">
                        <AssetsEntry />
                    </Route>
                    <Route>
                        <CatalogTabs
                            tools={<div>Tools</div>}
                            projects={[]}
                            scope="owner"
                            bridge={{} as ReturnType<typeof useBridge>}
                            embedded={embedded}
                            isMain
                            canManage
                            canChat
                        />
                    </Route>
                </Switch>
            </MemoryRouter>,
        ),
    );
    return history;
}
it('legacy link preserves exact recovery parameters and hash using replace', async () => {
    const history = await render(
        '/assets?prepare=recipe&recoverBuild=build&recoverImport=import&archive=open&p=project&q=term&unknown=keep#details',
    );
    expect(history.location.pathname).toBe('/store');
    const params = new URLSearchParams(history.location.search);
    for (const [key, value] of Object.entries({
        prepare: 'recipe',
        recoverBuild: 'build',
        recoverImport: 'import',
        archive: 'open',
        p: 'project',
        q: 'term',
        unknown: 'keep',
        tab: 'supplies',
    }))
        expect(params.get(key)).toBe(value);
    expect(history.location.hash).toBe('#details');
    expect(history.length).toBe(1);
    expect(container.textContent).toContain('Поставки общего каталога');
});
it.each(['flag', 'permission'])('legacy source screen remains available without %s', async (reason) => {
    if (reason === 'flag') io.enabled = false;
    else io.permissions = ['assets'];
    const history = await render('/assets?recoverImport=accepted#receipt');
    expect(history.location.pathname).toBe('/assets');
    expect(history.location.search).toBe('?recoverImport=accepted');
    expect(container.textContent).toContain('Прежний экран поставок');
});
it('project catalog changes catalogTab while preserving the project tab and context', async () => {
    const history = await render('/projects/project?tab=store&p=project&recoverBuild=old#section', true);
    const tab = Array.from(container.querySelectorAll('[role=tab]')).find((el) => el.textContent === 'Поставки')!;
    expect(tab).toBeDefined();
    await act(async () => tab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(history.location.pathname).toBe('/projects/project');
    const query = new URLSearchParams(history.location.search);
    expect(query.get('tab')).toBe('store');
    expect(query.get('catalogTab')).toBe('supplies');
    expect(query.get('p')).toBe('project');
    expect(query.get('recoverBuild')).toBe('old');
    expect(history.location.hash).toBe('#section');
    expect(container.textContent).toContain('Поставки общего каталога');
});
it.each(['role', 'permission'])('direct catalog link cannot mount sources without %s', async (reason) => {
    if (reason === 'role') io.role = 'Разработчик';
    else io.permissions = ['store'];
    await render('/store?tab=supplies&prepare=recipe');
    expect(container.textContent).toContain('Поставки доступны главному администратору');
    expect(io.mounted).not.toHaveBeenCalled();
});
it('turning navigation OFF while supplies are open returns to legacy recovery', async () => {
    io.enabled = false;
    const history = await render('/store?tab=supplies&recoverBuild=accepted#receipt');
    expect(history.location.pathname).toBe('/assets');
    expect(new URLSearchParams(history.location.search).get('recoverBuild')).toBe('accepted');
    expect(history.location.hash).toBe('#receipt');
    expect(container.textContent).toContain('Прежний экран поставок');
});
