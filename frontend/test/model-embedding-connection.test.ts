// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { ModelCatalog } from '../src/features/ModelCatalog/ModelCatalog';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';
import type { ICatalogModel, IModelCatalog } from '../src/features/ModelCatalog/types';
import type { IProjectEmbedding } from '../src/features/ProjectEmbedding/model';
import type { IProjectReindexPlan } from '../src/features/ProjectEmbedding/reindex';
import { ragUiFixture } from './ragUiFixture';

const ui = vi.hoisted(() => ({ scope: 'owner', owners: new Map<string, () => () => boolean>(), bridge: undefined as ReturnType<typeof ragUiFixture>['bridge'] | undefined }));
vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: { list: vi.fn(), assign: vi.fn(), unassign: vi.fn() } }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    const scope = ui.scope;
    if (!ui.owners.has(scope)) ui.owners.set(scope, () => () => ui.scope === scope);
    return { scope, captureOwner: ui.owners.get(scope)! };
} }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => ui.bridge }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ FeatureButton: (props: Record<string, unknown>) => {
    const { features: _features, loading: _loading, type: _type, children, ...button } = props;
    return createElement('button', button, children as ReactNode);
} }));
vi.mock('../src/features/ModelCatalog/ModelHosting', () => ({ ModelHosting: () => createElement('p', null, 'Готова') }));
vi.mock('../src/features/AssetManagement/ArchiveAssetButton', () => ({ ArchiveAssetButton: () => null }));
vi.mock('../src/features/Discussions', () => ({ CatalogFeedback: () => null }));
vi.mock('../src/features/ModelCatalog/ModelDetails', () => ({ ModelDetails: () => null }));
vi.mock('../src/features/ModelCatalog/ModelEditModal', () => ({ ModelEditModal: () => null }));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal', () => ({ RemoteConnectionModal: () => null }));
vi.mock('../src/features/ModelCatalog/OpenCodeImportModal', () => ({ OpenCodeImportModal: () => null }));
vi.mock('../src/features/ModelCatalog/DeviceCodexConnectionModal', () => ({ DeviceCodexConnectionModal: () => null }));
vi.mock('../src/features/ModelChat/ModelChatModal', () => ({ ModelChatModal: () => null }));
vi.mock('../src/features/OpenCodeProviders/ProviderSetupModal', () => ({ ProviderSetupModal: () => null }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Space: content, Row: content, Col: content, Tag: content, Tooltip: content, Spin: () => null, Empty: content, Progress: () => null,
        Typography: { Title: content, Text: content, Paragraph: content },
        Input: { Search: () => null }, Checkbox: () => null,
        Button: ({ children, onClick, disabled, ...props }: { children: ReactNode; onClick?: () => void; disabled?: boolean; [key: string]: unknown }) =>
            createElement('button', { onClick, disabled, 'aria-label': props['aria-label'] }, children),
        Select: ({ value, onChange, options, disabled, ...props }: { value?: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; disabled?: boolean; [key: string]: unknown }) =>
            createElement('select', { value, disabled, 'aria-label': props['aria-label'], onChange: (event: { target: { value: string } }) => onChange(event.target.value) },
                options.map(option => createElement('option', { key: option.value, value: option.value }, option.label))),
        Alert: ({ message, description, action }: { message: ReactNode; description?: ReactNode; action?: ReactNode }) => createElement('div', { role: 'status' }, message, description, action),
    };
});

const pin = 'a'.repeat(64), uuid = '12345678-1234-4234-8234-123456789012';
const model: ICatalogModel = { id: 'model-local', name: 'Qwen локальная', description: '', runtime: 'remote-ollama', capability: 'embedding', model: 'qwen3-embedding:0.6b',
    modelVersion: 'observed-sha', verificationSha256: 'b'.repeat(64), manifestSha256: null, modelPin: pin, dimension: 1024, source: 'custom', revision: 2, createdAt: '2026-10-24', updatedAt: '2026-10-24' };
const other = { ...model, id: 'model-other', name: 'Другая модель', modelPin: 'c'.repeat(64) };
const selection = (project = 'prj-one', selected: ICatalogModel | null = model): IProjectEmbedding => ({ projectId: project, revision: 3, expectedDimension: selected?.dimension ?? 0,
    model: selected, modelPin: selected?.modelPin ?? null, profile: selected ? { provider: 'openai', model: `neurocenter/${selected.id}/sha256/${selected.modelPin}`, dimension: selected.dimension! } : null,
    activeGeneration: uuid, activeSnapshot: selected ? 'd'.repeat(64) : null, dataRevision: 3 });
const plan = (state: IProjectReindexPlan['state'] = 'applied'): IProjectReindexPlan => ({ id: uuid, projectId: 'prj-one', state, digest: 'e'.repeat(64), approved: true,
    progress: 100, message: state === 'applied' ? 'Модель и индекс проекта переключены.' : 'План завершён без переключения.', createdAt: '2026-10-24T00:00:00Z',
    data: { context: { revision: 2, dataRevision: 2, generation: 'initial-' + 'f'.repeat(32) }, modelId: model.id, modelPin: pin, profile: selection().profile!, sourceSnapshot: null, rowCount: 0, requiredBytes: 0 } });
let selected: IProjectEmbedding, catalog: IModelCatalog, latest: IProjectReindexPlan | null, currentProject: string, canManage: boolean;
let container: HTMLElement, root: Root;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function render(project = currentProject) { currentProject = project; await act(async () => { root.render(createElement(ModelCatalog, { key: JSON.stringify([ui.scope, project]), projectId: project, canManage, isMain: false })); }); }
function card(name = model.name) { return container.querySelector<HTMLElement>(`article[aria-label="${name}"]`)!; }
function button(text: string, inside: HTMLElement = container) { const value = [...inside.querySelectorAll('button')].find(item => item.textContent === text); expect(value, text).toBeDefined(); return value!; }
async function server() { await act(async () => { const field = container.querySelector<HTMLSelectElement>('[aria-label="Область подключения модели"]')!; field.value = 'server'; field.dispatchEvent(new Event('change', { bubbles: true })); }); }
beforeEach(() => {
    vi.clearAllMocks(); ui.scope = 'owner'; ui.owners.clear(); ui.bridge = ragUiFixture().bridge;
    selected = selection(); catalog = { items: [model, other], assignedModelIds: [model.id, other.id] }; latest = null; currentProject = 'prj-one'; canManage = true;
    vi.mocked(modelCatalogApi.list).mockImplementation(async () => catalog);
    vi.mocked(api.get).mockImplementation(async url => ({ data: String(url).endsWith('/embedding') ? selected : latest }));
    vi.mocked(api.post).mockResolvedValue({ data: plan() });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('Подтверждённое серверное подключение в каталоге', () => {
    it('Показывает подключённую модель и не создаёт повторный reindex; соседняя модель остаётся доступна', async () => {
        await render(); await server();
        expect(button('Модель подключена', card()).disabled).toBe(true);
        await act(async () => { button('Модель подключена', card()).click(); });
        expect(api.post).not.toHaveBeenCalled(); expect(button('Подключить модель', card(other.name)).disabled).toBe(false);
    });
    it.each(['failed', 'cancelled', 'applied'] as const)('Последний план %s не подменяет фактический выбранный профиль', async state => {
        latest = plan(state); selected = selection('prj-one', null);
        await render(); await server(); expect(button('Подключить модель', card()).disabled).toBe(false);
    });
    it('После успешного intent перечитывает фактический выбор и закрывает повторную кнопку', async () => {
        selected = selection('prj-one', null); await render(); await server();
        vi.mocked(api.post).mockImplementationOnce(async () => { selected = selection(); return { data: plan() }; });
        await act(async () => { button('Подключить модель', card()).click(); });
        expect(api.post).toHaveBeenCalledOnce(); expect(button('Модель подключена', card()).disabled).toBe(true);
    });
    it('Новый pin той же модели и размерности снова разрешает подключение', async () => {
        catalog = { ...catalog, items: [{ ...model, modelPin: '9'.repeat(64), modelVersion: 'new-version' }, other] };
        await render(); await server(); expect(button('Подключить модель', card()).disabled).toBe(false);
    });
    it('Свежий положительный selection перед POST не создаёт второй серверный intent', async () => {
        selected = selection('prj-one', null); await render(); await server(); selected = selection();
        await act(async () => { button('Подключить модель', card()).click(); });
        expect(api.post).not.toHaveBeenCalled(); expect(button('Модель подключена', card()).disabled).toBe(true);
    });
});

describe('Подключение к точной установке компьютера', () => {
    function local() {
        const fixture = ragUiFixture(); ui.bridge = fixture.bridge;
        fixture.device.report.root = '/fixture/root'; fixture.device.report.capabilities!.push('hosted-rag-reindex-v1', 'hosted-rag-grants-v1', 'hosted-rag-profile-values-v1');
        fixture.item.hostedEmbedding = { supported: true, reindexSupported: true };
        fixture.item.inspection = { schemaVersion: 1, projectId: fixture.item.projectId, bindingId: fixture.binding.bindingId, assetId: fixture.item.assetId,
            assetKind: fixture.item.assetKind, version: fixture.item.version, manifest: fixture.item.manifest, checkedAt: '2026-10-24T01:00:00Z', readiness: 'unverified', state: 'checked', status: 'synced', issues: [] };
        fixture.bridge.jobs = [fixture.job({ kind: 'connect-rag-model', state: 'succeeded', result: { status: 'connected', revision: selected.revision, modelPin: selected.modelPin,
            profile: selected.profile, requiresRestart: true, reindex: { complete: true, serverSynced: true, rowCount: 0, snapshotHash: 'd'.repeat(64) } } })];
        return fixture;
    }
    it('Точный успешный receipt отключает повтор, но другая установка или экземпляр папки разрешены', async () => {
        const fixture = local(); await render(); expect(button('Модель подключена', card()).disabled).toBe(true);
        fixture.bridge.jobs = [{ ...fixture.bridge.jobs[0], expectedInstanceId: '22222222-2222-4222-8222-222222222222' }];
        await render(); expect(button('Подключить модель', card()).disabled).toBe(false);
        fixture.bridge.jobs = [{ ...fixture.bridge.jobs[0], expectedInstanceId: fixture.binding.instanceId, expectedManifest: '8'.repeat(64) }];
        await render(); expect(button('Подключить модель', card()).disabled).toBe(false); expect(api.post).not.toHaveBeenCalled();
    });
    it.each(['failed', 'cancelled'] as const)('Receipt %s не становится подтверждением локального подключения', async state => {
        const fixture = local(); fixture.bridge.jobs[0].state = state;
        await render(); expect(button('Подключить модель', card()).disabled).toBe(false);
    });
    it('Старая ревизия подключения не скрывает необходимое применение на компьютере', async () => {
        const fixture = local(); fixture.bridge.jobs[0].result!.revision = selected.revision - 1;
        await render(); expect(button('Подключить модель', card()).disabled).toBe(false);
    });
    it('Потерянный create ACK повторяет тот же intent после серверного переключения, пока компьютер не подтвердил подключение', async () => {
        selected = selection('prj-one', null); const fixture = local(); fixture.bridge.jobs = [];
        await render();
        vi.mocked(api.post).mockImplementationOnce(async () => { selected = { ...selection(), revision: 4, dataRevision: 4 }; throw Error('ACK lost'); });
        await act(async () => { button('Подключить модель', card()).click(); });
        const first = vi.mocked(api.post).mock.calls[0][1];
        vi.mocked(api.post).mockResolvedValueOnce({ data: { ...plan(), local: { jobId: uuid, state: 'queued', message: 'Ожидаем компьютер', percent: null } } });
        await act(async () => { button('Подключить модель', card()).click(); });
        expect(api.post).toHaveBeenCalledTimes(2); expect(vi.mocked(api.post).mock.calls[1][1]).toEqual(first);
    });
});

describe('Независимое чтение подключения и смена проекта', () => {
    it.each(['project', 'target', 'permission'] as const)('Поздний assign ACK после смены %s не запускает старое подключение', async change => {
        selected = selection('prj-one', null); catalog = { ...catalog, assignedModelIds: [] };
        vi.mocked(api.get).mockImplementation(async url => ({ data: String(url).endsWith('/embedding') ? selection(String(url).includes('/prj-two/') ? 'prj-two' : 'prj-one', null) : null }));
        const pending = deferred<{ ok: boolean }>(); vi.mocked(modelCatalogApi.assign).mockReturnValueOnce(pending.promise);
        await render(); await server(); await act(async () => { button('Добавить в проект', card()).click(); });
        expect(modelCatalogApi.assign).toHaveBeenCalledWith('prj-one', model.id);
        if (change === 'project') await render('prj-two');
        else if (change === 'permission') { canManage = false; await render(); }
        else await act(async () => { const field = container.querySelector<HTMLSelectElement>('[aria-label="Область подключения модели"]')!;
            field.value = 'computer'; field.dispatchEvent(new Event('change', { bubbles: true })); });
        const reads = vi.mocked(api.get).mock.calls.length;
        await act(async () => { pending.resolve({ ok: true }); });
        expect(api.get).toHaveBeenCalledTimes(reads); expect(api.post).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('Модель и индекс проекта переключены.');
    });
    it('Смена области подключения во время preflight не отправляет старый intent', async () => {
        selected = selection('prj-one', null); await render(); await server();
        const pending = deferred<{ data: IProjectEmbedding }>();
        vi.mocked(api.get).mockImplementationOnce(async () => pending.promise);
        await act(async () => { button('Подключить модель', card()).click(); });
        expect(container.querySelector<HTMLSelectElement>('[aria-label="Область подключения модели"]')!.disabled).toBe(true);
        await act(async () => { const field = container.querySelector<HTMLSelectElement>('[aria-label="Область подключения модели"]')!;
            field.value = 'computer'; field.dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => { pending.resolve({ data: selected }); });
        expect(api.post).not.toHaveBeenCalled();
    });
    it('Поздний отказ preflight старой области не публикует ошибку и не разблокирует новое действие', async () => {
        selected = selection('prj-one', null); await render(); await server();
        const old = deferred<{ data: IProjectEmbedding }>(); vi.mocked(api.get).mockImplementationOnce(async () => old.promise);
        await act(async () => { button('Подключить модель', card()).click(); });
        await act(async () => { const field = container.querySelector<HTMLSelectElement>('[aria-label="Область подключения модели"]')!;
            field.value = 'computer'; field.dispatchEvent(new Event('change', { bubbles: true })); });
        await server();
        const next = deferred<{ data: IProjectEmbedding }>(); vi.mocked(api.get).mockImplementationOnce(async () => next.promise);
        await act(async () => { button('Подключить модель', card()).click(); });
        await act(async () => { old.reject(Error('Ошибка прежней области')); });
        expect(container.textContent).not.toContain('Ошибка прежней области');
        expect(button('Подключить модель', card()).disabled).toBe(true);
        await act(async () => { selected = selection(); next.resolve({ data: selected }); });
        expect(button('Модель подключена', card()).disabled).toBe(true); expect(api.post).not.toHaveBeenCalled();
    });
    it('Ожидание selection блокирует только embedding-действие, сохраняя управление здоровой карточкой', async () => {
        const pending = deferred<{ data: IProjectEmbedding }>();
        vi.mocked(api.get).mockImplementation(async url => String(url).endsWith('/embedding') ? pending.promise : { data: null });
        await render(); await server(); expect(button('Проверяем подключение', card()).disabled).toBe(true);
        expect(button('Убрать из проекта', card()).disabled).toBe(false); expect(api.post).not.toHaveBeenCalled();
    });
    it('Поздний selection старого проекта не подключает модель в новом проекте', async () => {
        const old = deferred<{ data: IProjectEmbedding }>();
        vi.mocked(api.get).mockImplementation(async url => String(url).includes('/prj-one/embedding') && String(url).endsWith('/embedding') ? old.promise : { data: String(url).endsWith('/embedding') ? selection('prj-two', null) : null });
        await render(); await render('prj-two'); await server();
        await act(async () => { old.resolve({ data: selection() }); });
        expect(button('Подключить модель', card()).disabled).toBe(false); expect(api.post).not.toHaveBeenCalled();
    });
    it('Поздний selection прежнего owner не подтверждает подключение новой сессии', async () => {
        const pending = deferred<{ data: IProjectEmbedding }>(); let first = true;
        vi.mocked(api.get).mockImplementation(async url => {
            if (!String(url).endsWith('/embedding')) return { data: null };
            if (first) { first = false; return pending.promise; }
            return { data: selection('prj-one', null) };
        });
        await render(); ui.scope = 'new-owner'; await render(); await server();
        await act(async () => { pending.resolve({ data: selection() }); });
        expect(button('Подключить модель', card()).disabled).toBe(false); expect(api.post).not.toHaveBeenCalled();
    });
    it('Ошибка и повтор чтения не закрывают здоровые карточки и не запускают reindex', async () => {
        vi.mocked(api.get).mockImplementation(async url => { if (String(url).endsWith('/embedding')) throw Error('Связь временно недоступна'); return { data: null }; });
        await render(); await server();
        expect(button('Убрать из проекта', card()).disabled).toBe(false);
        expect(button('Подключение не проверено', card()).disabled).toBe(true);
        vi.mocked(api.get).mockImplementation(async url => ({ data: String(url).endsWith('/embedding') ? selected : null }));
        await act(async () => { button('Обновить подключение модели').click(); });
        expect(button('Модель подключена', card()).disabled).toBe(true); expect(api.post).not.toHaveBeenCalled();
    });
});
