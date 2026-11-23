// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Switch, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubModalBrowser } from '../../../features/ModelCatalog/tests/browser.fixture';
import type { IErrorEvent } from '../../../core/api/interfaces';
import ErrorList from '../Error';

const redux = vi.hoisted(() => ({
    dispatch: vi.fn(),
    state: undefined as unknown,
}));
vi.mock('react-redux', () => ({
    useSelector: (selector: (state: unknown) => unknown) => selector(redux.state),
    useDispatch: () => redux.dispatch,
}));
vi.mock('../redux/actions', () => ({
    // thunk-функция заменяется на фабрику action-объекта: dispatch-шпион получает
    // объект с type/payload, а не непрозрачную функцию createAsyncThunk.
    fetchError: (params: unknown) => ({ type: 'errors/fetchError/pending', payload: params }),
}));

const EVENT: IErrorEvent = {
    id: 'evt-1',
    service: 'frontend',
    ts: '2026-11-22T10:30:00.000Z',
    level: 'error',
    requestId: 'req-123',
    message: 'client-render-error',
    stackHint: 'component: NeurocenterShell\nat render (app.js:1)',
};
const SECOND: IErrorEvent = {
    ...EVENT,
    id: 'evt-2',
    service: 'catalog',
    requestId: null,
    message: 'crash.unhandledRejection',
    stackHint: null,
};
let root: Root;
let container: HTMLDivElement;
const findDispatched = (type: string) =>
    redux.dispatch.mock.calls.map((call) => call[0]).find((action) => (action as { type: string }).type === type);
const openPeriodSelect = async (): Promise<void> => {
    const combo = document.querySelector('[role=combobox][aria-label="Период журнала ошибок"]');
    if (!combo) throw new Error('period select not found');
    await act(async () =>
        (combo as HTMLElement)
            .closest('.ant-select-selector')!
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
};
const clickPeriodOption = async (label: string): Promise<void> => {
    const option = Array.from(document.querySelectorAll('.ant-select-item-option-content')).find(
        (node) => node.textContent === label,
    );
    if (!option) throw new Error('period option not found: ' + label);
    await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const AuditProbe = () => {
    const { search } = useLocation();
    return <div data-testid="audit-probe">audit:{search}</div>;
};

beforeEach(() => {
    redux.dispatch.mockReset();
    redux.state = {
        userBlock: { isAuth: true, user: { routePermissions: ['error', 'audit'] } },
        errors: {
            list: [EVENT, SECOND],
            page: 1,
            size: 20,
            total: 2,
            loading: false,
            error: null,
            loadedPage: 1,
            requestId: null,
            authScope: 'scope',
            authRequestId: null,
        },
    };
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
const renderPage = (): Promise<void> =>
    act(() =>
        root.render(
            <MemoryRouter initialEntries={['/error']}>
                <Switch>
                    <Route path="/audit">
                        <AuditProbe />
                    </Route>
                    <Route path="/error">
                        <ErrorList />
                    </Route>
                </Switch>
            </MemoryRouter>,
        ),
    );

describe('Error list (AD-O5)', () => {
    it('renders safe fields of the page and asks the API for page 1', async () => {
        await renderPage();
        const text = container.textContent ?? '';
        expect(text).toContain('Ошибки');
        expect(text).toContain('frontend');
        expect(text).toContain('catalog');
        expect(text).toContain('Ошибка интерфейса (render)');
        expect(text).toContain('Сбой сервиса (unhandled rejection)');
        expect(text).toContain('req-123');
        expect(text).toContain('На странице: 2 · всего: 2');
        const initial = findDispatched('errors/fetchError/pending');
        expect(initial).toBeDefined();
        expect((initial as { payload: unknown }).payload).toEqual({
            service: undefined,
            requestId: undefined,
            period: undefined,
            page: 1,
            size: 20,
        });
    });

    it('shows no raw stack hint in the list body', async () => {
        await renderPage();
        expect(container.textContent).not.toContain('at render (app.js:1)');
    });

    it('requests page 1 again with the chosen period', async () => {
        await renderPage();
        redux.dispatch.mockClear();
        await openPeriodSelect();
        await clickPeriodOption('24 часа');
        expect(findDispatched('errors/setPage')).toEqual({ type: 'errors/setPage', payload: 1 });
        const periodAction = redux.dispatch.mock.calls
            .map((call) => call[0])
            .filter((action) => (action as { type: string }).type === 'errors/fetchError/pending')
            .at(-1) as { payload: { period?: string; page: number; size: number } };
        expect(periodAction.payload.period).toBe('24h');
        expect(periodAction.payload.page).toBe(1);
    });

    it('opens the action history for the same requestId from the link', async () => {
        await renderPage();
        const link = container.querySelector<HTMLAnchorElement>('a[aria-label="История действий: req-123"]');
        expect(link).not.toBeNull();
        await act(async () => link!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const probe = document.querySelector('[data-testid="audit-probe"]');
        expect(probe?.textContent).toBe('audit:?search=req-123');
    });

    it('renders a dash for events without a requestId', async () => {
        await renderPage();
        const rows = container.querySelectorAll('tbody tr.ant-table-row');
        expect(rows.length).toBe(2);
        expect(rows[1].textContent).toContain('—');
        expect(rows[1].querySelector('a[aria-label^="История действий"]')).toBeNull();
    });

    it('shows safe details with frames in the drawer', async () => {
        await renderPage();
        const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Подробности:"]');
        expect(button).not.toBeNull();
        await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const body = document.body.textContent ?? '';
        expect(body).toContain('Подробности события');
        expect(body).toContain('Кадры (без значений)');
        expect(body).toContain('component: NeurocenterShell');
        expect(body).toContain('at render (app.js:1)');
        expect(body).toContain('Открыть в истории действий');
    });
});
