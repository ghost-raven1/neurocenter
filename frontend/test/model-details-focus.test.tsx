// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ModelCatalog} from '../src/features/ModelCatalog/ModelCatalog';

const h = vi.hoisted(() => ({refresh: vi.fn(), write: vi.fn(), items: ['a', 'b'].map(id => ({
    id: 'model-' + id, name: 'QA model ' + id, description: '', capability: 'chat', runtime: 'remote-openai', model: id,
    manifestSha256: null, dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '',
}))}));
// Match the read-only Catalog props when the optional quota section reads the authenticated role.
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: {email: 'viewer@example.test', activeRole: 'Наблюдатель', userRoles: ['Наблюдатель']}}})}));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({useModelCatalog: () => ({catalog: {items: h.items, assignedModelIds: []}, loading: false, error: '', refresh: h.refresh})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: 'qa-user', captureOwner: () => () => true})}));
vi.mock('../src/features/ProjectEmbedding/EmbeddingTarget', () => ({useEmbeddingTarget: () => ({mode: 'server', ready: true, blocked: false, bridge: {devices: [], jobs: []}}), EmbeddingTargetFields: () => null}));
vi.mock('../src/features/ProjectEmbedding/useProjectEmbeddingSelection', () => ({useProjectEmbeddingSelection: () => ({loading: false, refresh: vi.fn()})}));
vi.mock('../src/features/ProjectEmbedding/useProjectReindex', () => ({useProjectReindex: () => ({busy: false, pending: false})}));
vi.mock('../src/features/ProjectEmbedding/ProjectReindexStatus', () => ({ProjectReindexStatus: () => null}));
vi.mock('../src/features/ModelCatalog/api', () => ({modelCatalogApi: {endpoint: (id: string) => '/api/models/' + id + '/api', assign: h.write, unassign: h.write}}));
vi.mock('../src/features/ModelCatalog/ModelHosting', () => ({ModelHosting: () => null}));
vi.mock('../src/features/ModelRateLimits/ModelRateLimits', () => ({ModelRateLimits: () => null}));
vi.mock('../src/features/Discussions', () => ({CatalogFeedback: () => null}));
vi.mock('../src/features/AssetManagement/ArchiveAssetButton', () => ({ArchiveAssetButton: () => null}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', async () => {
    const {createElement} = await import('react'), {Button} = await import('antd');
    return {FeatureButton: ({features: _features, ...props}: {features: string[]}) => createElement(Button, props)};
});
vi.mock('../src/features/ModelCatalog/ModelEditModal', () => ({ModelEditModal: () => null}));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal', () => ({RemoteConnectionModal: () => null}));
vi.mock('../src/features/ModelCatalog/OpenCodeImportModal', () => ({OpenCodeImportModal: () => null}));
vi.mock('../src/features/ModelCatalog/DeviceCodexConnectionModal', () => ({DeviceCodexConnectionModal: () => null}));
vi.mock('../src/features/OpenCodeProviders/ProviderSetupModal', () => ({ProviderSetupModal: () => null}));
vi.mock('../src/features/ModelChat/ModelChatModal', () => ({ModelChatModal: () => null}));

let root: Root, container: HTMLDivElement;
const opener = (id = 'a') => container.querySelector<HTMLButtonElement>(`[aria-label="Подробнее о модели: QA model ${id}"]`)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const click = async (element: HTMLElement) => {await act(async () => {element.click();});};
const frames = async () => {await act(async () => {await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));});};
async function open(id = 'a') {
    const trigger = opener(id); trigger.focus(); await click(trigger);
    await vi.waitFor(() => expect(dialog()?.contains(document.activeElement)).toBe(true));
    return trigger;
}
beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}}));
    // Supply layout visibility only; real Catalog/Card/Details/AntD Modal control all lifecycle and focus.
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {return this.parentElement;});
    h.write.mockClear(); h.refresh.mockClear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => {root.render(createElement(ModelCatalog, {canManage: false, isMain: false}));});
});
afterEach(async () => {await act(async () => {root.unmount();}); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

it.each(['Escape', 'close button'])('%s returns focus to the connected real model title after the Catalog closes Details', async method => {
    const trigger = await open(); expect(trigger.isConnected).toBe(true);
    if (method === 'Escape') await act(async () => {document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, which: 27, bubbles: true}));});
    else await click(Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Закрыть')!);
    await vi.waitFor(() => expect(dialog()).toBeNull()); await frames();
    expect(trigger.isConnected).toBe(true); expect(document.activeElement).toBe(trigger);
    expect(h.write).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
    // Closing one owner must not leave the next model's modal stuck closed or return to the previous title.
    const next = await open('b'); expect(dialog()?.textContent).toContain('QA model b');
    await click(Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Закрыть')!);
    await vi.waitFor(() => expect(dialog()).toBeNull()); await frames(); expect(document.activeElement).toBe(next);
});
