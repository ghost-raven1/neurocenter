// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Switch, useHistory } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OperationsQueue from '../OperationsQueue';
import { stubModalBrowser } from '../../../features/ModelCatalog/tests/browser.fixture';

const bff = vi.hoisted(() => ({
    listOperations: vi.fn(),
    getOperation: vi.fn(),
    retryOperation: vi.fn(),
    cancelOperation: vi.fn(),
}));
vi.mock('../../../core/api/bff', () => ({ default: bff }));
vi.mock('react-redux', () => {
    const state = {
        userBlock: {
            user: {
                id: 'owner',
                email: 'owner@example.test',
                principalName: 'owner',
                activeRole: 'Главный админ',
                userRoles: ['Главный админ'],
                routePermissions: [],
                projectRoles: [],
            },
            policies: [],
        },
    };
    const store = { getState: () => state };
    return {
        useSelector: (select: (value: unknown) => unknown) => select(state),
        useStore: () => store,
    };
});
vi.mock('../../../core/socket/hooks/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../../../features/TabNotifications/hooks/useTabWatch', () => ({ useTabWatch: () => undefined }));

let root: Root, container: HTMLDivElement, history: ReturnType<typeof useHistory>;
function Probe(): null {
    history = useHistory();
    return null;
}
function render(entry: string) {
    root.render(
        <MemoryRouter initialEntries={[entry]}>
            <Probe />
            <Switch>
                <Route path="/operations">
                    <OperationsQueue />
                </Route>
                <Route path="/projects/:id">
                    <div>project page</div>
                </Route>
            </Switch>
        </MemoryRouter>,
    );
}
const backButton = (): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Вернуться в исходный раздел'),
    );

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    bff.listOperations.mockResolvedValue({
        items: [],
        page: 1,
        size: 10,
        total: 0,
        activeCount: 0,
        activeProgress: { percent: 0, running: 0, queued: 0 },
    });
    bff.getOperation.mockResolvedValue(null as never);
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

it('returns to the source section from a valid return destination', async () => {
    await act(async () => render('/operations?return=' + encodeURIComponent('/projects/abc?tab=rag')));
    expect(bff.listOperations).toHaveBeenCalled();
    const button = backButton();
    expect(button?.textContent).toContain('Вернуться в исходный раздел');
    await act(async () => {
        button?.click();
    });
    expect(history.location.pathname).toBe('/projects/abc');
    expect(history.location.search).toBe('?tab=rag');
    expect(backButton()).toBeUndefined();
});
it('keeps the queue clean when the return destination is invalid', async () => {
    await act(async () => render('/operations?return=' + encodeURIComponent('//evil.example')));
    expect(backButton()).toBeUndefined();
    expect(history.location.pathname).toBe('/operations');
});
it('does not offer a return without the parameter', async () => {
    await act(async () => render('/operations?operation=op-1'));
    expect(backButton()).toBeUndefined();
});
