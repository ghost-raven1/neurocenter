import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredSetup, flushSetup} from './admin-setup-hooks.fixture';
import type {IFeatureFlag, IEvaluatedFeatureFlags, TFeatureFlagKey} from '../src/features/FeatureFlags/types';
import type {IModelCatalog} from '../src/features/ModelCatalog/types';
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture');
    return {hooks: adminSetupHooks(), scope: 'alice', active: true, captures: new Map<string, () => () => boolean>(),
        live: undefined as undefined | {sections: readonly string[]; callback: () => void; enabled: boolean},
        buttons: new Map<string, {disabled?: boolean; loading?: boolean; onClick?: (event: unknown) => void}>()};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref,
    useMemo: h.hooks.memo, useCallback: h.hooks.callback, useEffect: h.hooks.effect, useLayoutEffect: h.hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    if (!h.captures.has(h.scope)) { const scope = h.scope; h.captures.set(scope, () => () => h.active && h.scope === scope); }
    return {scope: h.scope, captureOwner: h.captures.get(h.scope)!};
}}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: (sections: readonly string[], callback: () => void, enabled = true) => { h.live = {sections, callback, enabled}; }}));
vi.mock('../src/features/FeatureFlags/api', () => ({featureFlagsApi: {evaluated: vi.fn(), list: vi.fn(), update: vi.fn()}}));
vi.mock('../src/features/ModelCatalog/api', () => ({modelCatalogApi: {list: vi.fn()}}));
vi.mock('antd', () => ({
    Button: (props: {children?: ReactNode; disabled?: boolean; loading?: boolean; onClick?: (event: unknown) => void}) => {
        h.buttons.set(String(props.children), props); return createElement('button', {disabled: props.disabled}, props.children);
    }, Alert: ({message, action}: {message: ReactNode; action: ReactNode}) => createElement('div', null, message, action),
    Tooltip: ({children}: {children: ReactNode}) => children,
}));
import {FeatureAvailabilityContext, FeatureAvailabilityNotice, FeatureAvailabilityProvider, FeatureButton, FEATURE_FLAGS_CHANGED} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureDefinition, featureFlagKeys} from '../src/features/FeatureFlags/types';
import {useFeatureFlags} from '../src/features/FeatureFlags/useFeatureFlags';
import {featureFlagsApi} from '../src/features/FeatureFlags/api';
import {useModelCatalog} from '../src/features/ModelCatalog/useModelCatalog';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
import {model} from './model-chat-fixtures';

const flag = (key: TFeatureFlagKey, enabled = true, revision = 1): IFeatureFlag => ({...featureDefinition(key), enabled, revision, updatedAt: null, updatedBy: null});
const list = (...overrides: IFeatureFlag[]) => ({items: featureFlagKeys.map(key => overrides.find(item => item.key === key) ?? flag(key))});
const evaluated = (enabled = true): IEvaluatedFeatureFlags => ({flags: Object.fromEntries(featureFlagKeys.map(key => [key, enabled])),
    configured: Object.fromEntries(featureFlagKeys.map(key => [key, enabled])), blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []]))}) as IEvaluatedFeatureFlags;
const catalog = (id = model.id): IModelCatalog => ({items: [{...model, id}], assignedModelIds: [id]});
const httpError = (status: number) => ({isAxiosError: true, response: {status, data: {message: 'Доступ изменился'}}});
let bus: EventTarget, projectId: string | undefined;
const provider = () => { h.hooks.begin(); const tree = FeatureAvailabilityProvider({children: null}); h.hooks.commit(); return tree.props.value as React.ContextType<typeof FeatureAvailabilityContext>; };
const flags = () => { h.hooks.begin(); const value = useFeatureFlags(); h.hooks.commit(); return value; };
const models = () => { h.hooks.begin(); const value = useModelCatalog(projectId); h.hooks.commit(); return value; };
beforeEach(() => {
    h.hooks.dispose(); vi.clearAllMocks(); h.scope = 'alice'; h.active = true; h.captures.clear(); h.live = undefined; h.buttons.clear(); projectId = 'prj-one';
    bus = new EventTarget(); vi.stubGlobal('window', bus);
    vi.mocked(featureFlagsApi.evaluated).mockResolvedValue(evaluated()); vi.mocked(featureFlagsApi.list).mockResolvedValue(list());
    vi.mocked(featureFlagsApi.update).mockImplementation(async (key, enabled, revision) => flag(key, enabled, revision + 1));
    vi.mocked(modelCatalogApi.list).mockResolvedValue(catalog());
});
afterEach(() => { h.hooks.dispose(); vi.unstubAllGlobals(); });

describe('Shared feature provider: lifecycle, private owner and recovery', () => {
    it('loads once per owner, shares explicit refresh, listens for local changes and maintenance live updates', async () => {
        expect(provider().data).toBeNull(); await flushSetup(); expect(provider().data?.flags.agents).toBe(true);
        provider(); expect(featureFlagsApi.evaluated).toHaveBeenCalledOnce(); expect(h.live).toMatchObject({sections: ['maintenance'], enabled: true});
        bus.dispatchEvent(new Event(FEATURE_FLAGS_CHANGED)); await flushSetup(); expect(featureFlagsApi.evaluated).toHaveBeenCalledTimes(2);
        h.live!.callback(); await flushSetup(); await provider().refresh(); expect(featureFlagsApi.evaluated).toHaveBeenCalledTimes(4);
        h.hooks.dispose(); bus.dispatchEvent(new Event(FEATURE_FLAGS_CHANGED)); await flushSetup(); expect(featureFlagsApi.evaluated).toHaveBeenCalledTimes(4);
    });
    it('anonymous scope does not read on setup or local events, and disables live invalidation', async () => {
        h.scope = ''; provider(); bus.dispatchEvent(new Event(FEATURE_FLAGS_CHANGED)); await flushSetup();
        expect(featureFlagsApi.evaluated).not.toHaveBeenCalled(); expect(h.live?.enabled).toBe(false);
    });
    it.each(['resolve', 'reject'] as const)('a former owner late %s cannot enter the new provider', async outcome => {
        const old = deferredSetup<IEvaluatedFeatureFlags>(), current = deferredSetup<IEvaluatedFeatureFlags>();
        vi.mocked(featureFlagsApi.evaluated).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); provider(); h.scope = 'bob'; expect(provider().data).toBeNull();
        if (outcome === 'resolve') old.resolve(evaluated(false)); else old.reject(Error('PRIVATE OLD OWNER'));
        await flushSetup(); expect(provider().data).toBeNull(); expect(provider().error).toBeNull(); current.resolve(evaluated()); await flushSetup(); expect(provider().data?.flags.model_chat).toBe(true);
    });
    it('a failed refresh fails closed, retry restores server truth, and StrictMode rejects its first setup receipt', async () => {
        provider(); await flushSetup(); vi.mocked(featureFlagsApi.evaluated).mockRejectedValueOnce(Error('Нет сети')); await provider().refresh();
        expect(provider()).toMatchObject({data: null, loading: false, error: 'Нет сети'}); await provider().refresh(); expect(provider().error).toBeNull();
        h.hooks.dispose(); const old = deferredSetup<IEvaluatedFeatureFlags>(); vi.mocked(featureFlagsApi.evaluated).mockReturnValueOnce(old.promise); provider(); h.hooks.replayEffects(); await flushSetup(); old.resolve(evaluated(false)); await flushSetup(); expect(provider().data?.flags.agents).toBe(true);
    });
    it('notice retry, loading feedback, default context and external ACL disabled are real action guards', async () => {
        const refresh = vi.fn(async () => undefined), action = vi.fn();
        const render = (data: IEvaluatedFeatureFlags | null, loading = false, error: string | null = null) => renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider,
            {value: {data, loading, error, refresh}}, createElement(FeatureAvailabilityNotice, {features: ['agents']})));
        expect(render(evaluated())).toBe(''); expect(render(null, true)).toContain('Проверяем'); expect(h.buttons.get('Проверить')?.loading).toBe(true);
        h.buttons.get('Проверить')!.onClick?.({}); await flushSetup(); expect(refresh).toHaveBeenCalledOnce(); expect(render(null, false, 'Сбой')).toContain('не подтверждена');
        renderToStaticMarkup(createElement(FeatureAvailabilityNotice, {features: ['agents']})); h.buttons.get('Проверить')!.onClick?.({}); await flushSetup();
        renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, {value: {data: evaluated(), loading: false, error: null, refresh}},
            createElement(FeatureButton, {features: ['agents'], disabled: true, onClick: action}, 'Сохранить')));
        h.buttons.get('Сохранить')!.onClick?.({}); expect(action).not.toHaveBeenCalled();
        expect(renderToStaticMarkup(createElement(FeatureButton, {features: ['agents'], block: true}, 'Создать'))).toContain('feature-action_block');
        renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, {value: {data: evaluated(), loading: false, error: null, refresh}}, createElement(FeatureButton, {features: []}, 'Recovery')));
        h.buttons.get('Recovery')!.onClick?.({});
    });
});

describe('Feature admin hook: actual CAS controller and broadcast wiring', () => {
    it('uses the confirmed revision and broadcasts only a resolved write, while live reads wait for it', async () => {
        const changed = vi.fn(); bus.addEventListener(FEATURE_FLAGS_CHANGED, changed); flags(); await flushSetup(); let value = flags();
        expect(value.items).toHaveLength(featureFlagKeys.length); expect(h.live?.sections).toEqual(['maintenance']);
        const pending = deferredSetup<IFeatureFlag>(); vi.mocked(featureFlagsApi.update).mockReturnValueOnce(pending.promise); const saving = value.save('agents', false); h.live!.callback();
        expect(featureFlagsApi.list).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled(); expect(flags().rows.agents.saving).toBe(true);
        vi.mocked(featureFlagsApi.list).mockResolvedValue(list(flag('agents', false, 2))); pending.resolve(flag('agents', false, 2)); await saving; await flushSetup(); value = flags();
        expect(featureFlagsApi.update).toHaveBeenCalledExactlyOnceWith('agents', false, 1); expect(changed).toHaveBeenCalledOnce(); expect(featureFlagsApi.list).toHaveBeenCalledTimes(2);
        expect(value.items?.find(item => item.key === 'agents')).toMatchObject({enabled: false, revision: 2}); expect(value.rows.agents.saving).toBe(false);
    });
    it('conflict requires explicit useCurrent, network failure never broadcasts or silently changes a value', async () => {
        const changed = vi.fn(); bus.addEventListener(FEATURE_FLAGS_CHANGED, changed); flags(); await flushSetup();
        vi.mocked(featureFlagsApi.update).mockRejectedValueOnce(httpError(409)); vi.mocked(featureFlagsApi.list).mockResolvedValue(list(flag('agents', false, 4)));
        await flags().save('agents', false); await flushSetup(); expect(flags().rows.agents.needsReview).toBe(true); await flags().save('agents', true); expect(featureFlagsApi.update).toHaveBeenCalledOnce();
        flags().useCurrent('agents'); await flags().save('agents', true); expect(featureFlagsApi.update).toHaveBeenLastCalledWith('agents', true, 4); expect(changed).toHaveBeenCalledOnce();
        vi.mocked(featureFlagsApi.update).mockRejectedValueOnce(Error('Запись недоступна')); await flags().save('rag_sync', false); expect(flags().rows.rag_sync.error).toBe('Запись недоступна'); expect(changed).toHaveBeenCalledOnce();
    });
    it.each(['resolve', 'reject'] as const)('disposed or replaced admin ignores late %s and its old actions', async outcome => {
        flags(); await flushSetup(); const old = flags(), pending = deferredSetup<IFeatureFlag>(); vi.mocked(featureFlagsApi.update).mockReturnValueOnce(pending.promise); const writing = old.save('agents', false);
        h.scope = 'bob'; flags(); await flushSetup(); if (outcome === 'resolve') pending.resolve(flag('agents', false, 2)); else pending.reject(Error('PRIVATE ADMIN ERROR'));
        await writing; expect(flags().rows.agents).toMatchObject({saving: false, saved: false, error: null}); expect(flags().items?.find(item => item.key === 'agents')?.enabled).toBe(true);
        await old.save('rag_sync', false); expect(featureFlagsApi.update).toHaveBeenCalledOnce();
    });
    it('StrictMode cleanup/setup admits only the current GET; unmount prevents late reads', async () => {
        const old = deferredSetup<ReturnType<typeof list>>(); vi.mocked(featureFlagsApi.list).mockReturnValueOnce(old.promise); flags(); h.hooks.replayEffects(); await flushSetup();
        old.resolve(list(flag('agents', false))); await flushSetup(); expect(flags().items?.find(item => item.key === 'agents')?.enabled).toBe(true);
        const pending = deferredSetup<ReturnType<typeof list>>(); vi.mocked(featureFlagsApi.list).mockReturnValueOnce(pending.promise); const previous = flags(); const running = previous.refresh(); h.hooks.dispose(); pending.reject(Error('Closed read')); await running;
        await previous.refresh(); expect(featureFlagsApi.list).toHaveBeenCalledTimes(3);
    });
});

describe('Model catalog reader: owner, generations and usable recovery', () => {
    it('reads the explicit project once, subscribes to all invalidations, and live refresh clears a prior error', async () => {
        models(); await flushSetup(); expect(models().catalog?.items[0].id).toBe(model.id); models(); expect(modelCatalogApi.list).toHaveBeenCalledExactlyOnceWith('prj-one');
        expect(h.live?.sections).toEqual(['catalog', 'projects', 'access']); vi.mocked(modelCatalogApi.list).mockRejectedValueOnce(Error('Каталог недоступен')); h.live!.callback(); await flushSetup(); expect(models().error).toBe('Каталог недоступен');
        await models().refresh(); expect(models().error).toBe(''); expect(models().loading).toBe(false);
    });
    it.each(['resolve', 'reject'] as const)('newest refresh wins against old %s without dropping its pending indicator', async outcome => {
        const old = deferredSetup<IModelCatalog>(), current = deferredSetup<IModelCatalog>(); vi.mocked(modelCatalogApi.list).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); const first = models(), running = first.refresh();
        if (outcome === 'resolve') old.resolve(catalog('stale')); else old.reject(Error('OLD FAILURE')); await flushSetup(); expect(models()).toMatchObject({catalog: null, loading: true, error: ''});
        current.resolve(catalog('current')); await running; expect(models()).toMatchObject({loading: false, error: ''}); expect(models().catalog?.items[0].id).toBe('current');
    });
    it('an incomplete response keeps the last confirmed list, makes the problem visible and retries safely', async () => {
        models(); await flushSetup(); vi.mocked(modelCatalogApi.list).mockResolvedValueOnce({items: [], assignedModelIds: undefined} as unknown as IModelCatalog); await models().refresh();
        expect(models().catalog?.items[0].id).toBe(model.id); expect(models().error).toContain('неполный каталог'); vi.mocked(modelCatalogApi.list).mockRejectedValueOnce(undefined); await models().refresh(); expect(models().error).toContain('Не удалось загрузить');
        await models().refresh(); expect(models().error).toBe('');
    });
    it.each(['resolve', 'reject'] as const)('scope cleanup rejects old %s, and obsolete actions do not start another request', async outcome => {
        const pending = deferredSetup<IModelCatalog>(); vi.mocked(modelCatalogApi.list).mockReturnValueOnce(pending.promise); const old = models(); h.scope = 'bob'; projectId = 'prj-two'; vi.mocked(modelCatalogApi.list).mockResolvedValueOnce(catalog('bob-model')); models(); await flushSetup();
        if (outcome === 'resolve') pending.resolve(catalog('PRIVATE')); else pending.reject(Error('PRIVATE ERROR')); await flushSetup(); await old.refresh();
        expect(modelCatalogApi.list).toHaveBeenCalledTimes(2); expect(models().catalog?.items[0].id).toBe('bob-model'); expect(models().error).toBe('');
    });
    it('unmount and a synchronously revoked owner suppress late receipts and further reads', async () => {
        const pending = deferredSetup<IModelCatalog>(); vi.mocked(modelCatalogApi.list).mockReturnValueOnce(pending.promise); const value = models(); h.active = false; await value.refresh(); expect(modelCatalogApi.list).toHaveBeenCalledOnce();
        pending.resolve(catalog()); await flushSetup(); expect(models().catalog).toBeNull(); h.active = true; const last = deferredSetup<IModelCatalog>(); vi.mocked(modelCatalogApi.list).mockReturnValueOnce(last.promise); const running = value.refresh(); h.hooks.dispose(); last.reject(Error('Closed')); await running;
    });
});
