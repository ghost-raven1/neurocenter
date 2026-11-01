// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import AssetSources from '../AssetSources';
import { stubModalBrowser } from '../../ModelCatalog/tests/browser.fixture';
const io = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../core/api', () => ({ baseApi: io, bffApi: {} }));
vi.mock('react-redux', () => ({
    useSelector: (select: (value: unknown) => unknown) =>
        select({ userBlock: { user: { activeRole: 'Главный админ', userRoles: ['Главный админ'] } } }),
}));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
vi.mock('../../../core/socket/hooks/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../BundledCatalogSources', () => ({ BundledCatalogSources: () => null }));
vi.mock('../../Catalog/StoreEditModal', () => ({ default: () => null }));

let root: Root, container: HTMLDivElement;
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    localStorage.clear();
    io.get.mockImplementation(async (path: string) => ({
        data:
            path === '/api/asset-sources'
                ? {
                      source: { repository: 'bundled', mode: 'bundled', verified: true },
                      assets: [],
                      localAssets: [],
                      sourcePlans: [],
                  }
                : { id, state: 'FAILED', planDigest: 'digest', message: 'Сохранённый импорт', items: [] },
    }));
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
async function render(search = '') {
    await act(async () =>
        root.render(
            <MemoryRouter initialEntries={['/store?tab=supplies' + search]}>
                <AssetSources embedded />
            </MemoryRouter>,
        ),
    );
}
it('empty embedded supplies explicitly stays global and performs only reads', async () => {
    await render();
    expect(container.textContent).toContain('Поставки публикуются в общий каталог');
    expect(container.querySelector('h1')).toBeNull();
    expect(io.get).toHaveBeenCalledWith('/api/asset-sources');
    expect(io.post).not.toHaveBeenCalled();
});
it('opens the exact retained import from catalog URL without writing a new intent', async () => {
    localStorage.setItem('unrelated-draft', 'keep');
    await render('&recoverImport=' + id);
    expect(io.get).toHaveBeenCalledWith('/api/asset-imports/' + id);
    expect(container.textContent).toContain('Сохранённый импорт');
    expect(io.post).not.toHaveBeenCalled();
    expect(localStorage.getItem('unrelated-draft')).toBe('keep');
    expect(localStorage.getItem('asset-import:owner')).toBeNull();
});
