// @vitest-environment jsdom
import './feature-flags-enabled';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LearningAnalysisModal} from '../src/features/ProjectLearning/LearningAnalysisModal';
import {AgentTrialModal} from '../src/features/AgentCatalog/AgentTrialModal';
import {ProviderSetupModal, type IProviderSetupModalProps} from '../src/features/OpenCodeProviders/ProviderSetupModal';
import {useProjectEmbedding} from '../src/features/ProjectEmbedding/useProjectEmbedding';
import {useLearningResources} from '../src/features/ProjectLearning/useLearningResources';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
import {projectEmbeddingApi, type IProjectEmbedding} from '../src/features/ProjectEmbedding/model';
import {readinessItem, trial} from './agent-readiness.fixture';
import type {IAgentReadinessItem} from '../src/features/AgentCatalog/readinessTypes';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';

const f = vi.hoisted(() => ({start: vi.fn(), open: vi.fn(), check: vi.fn(), captureOwner: () => () => true}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: 'owner', captureOwner: f.captureOwner})}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: () => undefined}));
vi.mock('../src/features/ModelCatalog/api', () => ({modelCatalogApi: {list: vi.fn()}}));
vi.mock('../src/features/AgentCatalog/api', () => ({agentCatalogApi: {list: vi.fn(async () => ({assignments: []}))}}));
vi.mock('../src/features/ProjectEmbedding/model', async original => ({...await original<typeof import('../src/features/ProjectEmbedding/model')>(), projectEmbeddingApi: {read: vi.fn(), save: vi.fn()}}));
vi.mock('react-router-dom', () => ({useHistory: () => ({push: vi.fn()})}));
vi.mock('../src/features/OpenCodeProviders/useProviderSetup', () => ({useProviderSetup: () => ({open: f.open, check: f.check, reload: vi.fn(), retry: vi.fn()})}));
vi.mock('../src/features/OpenCodeProviders/useCodexSupply', () => ({useCodexSupply: () => ({})}));
vi.mock('antd', async original => {
    const actual = await original<typeof import('antd')>();
    return {...actual, Modal: ({children, footer}: {children?: ReactNode; footer?: ReactNode}) => createElement('section', null, children, footer),
        Select: ({value, onChange, options = [], mode, ...props}: {value?: string | string[]; onChange?: (value: string | undefined) => void; options?: {value: string; label: string; disabled?: boolean}[]; mode?: string; 'aria-label'?: string; id?: string; disabled?: boolean}) => createElement('select', {
            id: props.id, 'aria-label': props['aria-label'], value: Array.isArray(value) ? '' : value ?? '', disabled: props.disabled,
            onChange: (event: {target: {value: string}}) => onChange?.(event.target.value || undefined),
        }, createElement('option', {value: ''}, 'Нет выбора'), ...options.map(option => createElement('option', {key: option.value, value: option.value, disabled: option.disabled}, option.label)))};
});
const model = (id: string, changes: Partial<ICatalogModel> = {}): ICatalogModel => ({id, name: id, description: '', capability: 'chat', runtime: 'remote-openai', model: id, verificationSha256: 'a'.repeat(64), modelPin: 'b'.repeat(64), manifestSha256: null, dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '', ...changes});
let root: Root, host: HTMLDivElement, models: ICatalogModel[], item: IAgentReadinessItem, provider: IProviderSetupModalProps;
let embedding: ReturnType<typeof useProjectEmbedding>, resources: ReturnType<typeof useLearningResources>, saved: IProjectEmbedding;
function EmbeddingHarness() {embedding = useProjectEmbedding('prj-one'); return createElement('output', null, embedding.modelId);}
function ResourcesHarness() {resources = useLearningResources('prj-one', true); return null;}
const settle = async () => {await act(async () => {for (let n = 0; n < 16; n++) await Promise.resolve();});};
async function render(kind: 'learning' | 'trial' | 'provider' | 'embedding' | 'resources') {
    await act(async () => root.render(kind === 'learning' ? createElement(LearningAnalysisModal, {projectId: 'prj-one', revision: 1, experiences: [], models, busy: false, error: '', unconfirmed: false, onClose: vi.fn(), onStart: f.start})
        : kind === 'trial' ? createElement(AgentTrialModal, {projectId: 'prj-one', name: 'Агент', item, busy: false, loading: false, error: '', uncertain: false, onClose: vi.fn(), onRefresh: vi.fn(), onReplay: vi.fn(), onStart: f.start, onCancel: vi.fn()})
        : kind === 'provider' ? createElement(ProviderSetupModal, provider) : kind === 'embedding' ? createElement(EmbeddingHarness) : createElement(ResourcesHarness))); await settle();
}
const choice = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
async function choose(label: string, value: string) {await act(async () => {const select = choice(label); select.value = value; select.dispatchEvent(new Event('change', {bubbles: true}));}); await settle();}
beforeEach(() => {
    vi.clearAllMocks(); models = [model('first'), model('second')]; item = readinessItem();
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true}); window.matchMedia = vi.fn().mockImplementation(() => ({matches: false, addListener: vi.fn(), removeListener: vi.fn()}));
    provider = {bridge: {devicesReady: false, jobsReady: false, errors: {}, devices: [], jobs: [], choose: vi.fn()} as unknown as IProviderSetupModalProps['bridge'], projectId: 'prj-one', models, canManage: true, catalogReady: true, onReloadModels: vi.fn(), onClose: vi.fn()};
    saved = {projectId: 'prj-one', revision: 0, model: null, modelPin: null, profile: null, expectedDimension: 1024, activeGeneration: 'initial-' + 'a'.repeat(32), activeSnapshot: null, dataRevision: 0};
    vi.mocked(projectEmbeddingApi.read).mockImplementation(async () => saved);
    vi.mocked(modelCatalogApi.list).mockImplementation(async () => ({items: models, assignedModelIds: models.map(value => value.id)}));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();});

describe('First eligible models fill only an untouched draft', () => {
    it('learning fills late options, preserves manual selection and explicit clear, and never starts analysis', async () => {
        models = []; await render('learning'); expect(choice('Модель проекта для анализа').value).toBe(''); expect(document.body.textContent).toContain('Открыть модели проекта');
        models = [model('first'), model('second')]; await render('learning'); expect(choice('Модель проекта для анализа').value).toBe('first');
        await choose('Модель проекта для анализа', 'second'); models = [model('third'), ...models]; await render('learning'); expect(choice('Модель проекта для анализа').value).toBe('second');
        await choose('Модель проекта для анализа', ''); await render('learning'); expect(choice('Модель проекта для анализа').value).toBe(''); expect(f.start).not.toHaveBeenCalled();
    });
    it('trial skips unavailable entries, fills late metadata and preserves a manual choice', async () => {
        item.eligibility.models = []; await render('trial'); expect(choice('Модель для испытания').value).toBe('');
        item = {...item, eligibility: {...item.eligibility, models: [{id: 'blocked', name: 'blocked', pin: '', available: false}, {id: 'second', name: 'second', pin: '', available: true}, {id: 'third', name: 'third', pin: '', available: true}]}};
        await render('trial'); expect(choice('Модель для испытания').value).toBe('second'); await choose('Модель для испытания', 'third');
        item = {...item, eligibility: {...item.eligibility, models: [{id: 'fresh', name: 'fresh', pin: '', available: true}, ...item.eligibility.models]}}; await render('trial'); expect(choice('Модель для испытания').value).toBe('third'); expect(f.start).not.toHaveBeenCalled();
    });
    it('trial keeps the last receipt instead of replacing it with the first option', async () => {
        item.latestTrial = trial(); item.eligibility.models.unshift({id: 'fresh', name: 'fresh', pin: '', available: true}); await render('trial'); expect(choice('Модель для испытания').value).toBe('model-one');
    });
    it('provider fills the first compatible model only after catalog readiness and keeps separate drafts per kind', async () => {
        provider.catalogReady = false; provider.models = [model('embedding', {capability: 'embedding'}), model('unverified', {verificationSha256: null}), ...models, model('ollama', {runtime: 'remote-ollama'})];
        await render('provider'); expect(choice('API-модель для OpenCode').value).toBe(''); provider = {...provider, catalogReady: true}; await render('provider'); expect(choice('API-модель для OpenCode').value).toBe('first');
        await choose('API-модель для OpenCode', 'second'); await choose('Тип провайдера OpenCode', 'ollama'); expect(choice('API-модель для OpenCode').value).toBe('ollama');
        await choose('Тип провайдера OpenCode', 'openai-compatible'); expect(choice('API-модель для OpenCode').value).toBe('second');
        await choose('API-модель для OpenCode', ''); provider = {...provider, models: [...provider.models]}; await render('provider'); expect(choice('API-модель для OpenCode').value).toBe(''); expect(f.open).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
    });
    it('provider preserves a supplied handoff and offers setup when no compatible model exists', async () => {
        provider.initialModelId = 'second'; await render('provider'); expect(choice('API-модель для OpenCode').value).toBe('second');
        provider = {...provider, models: []}; await render('provider'); expect(document.body.textContent).toContain('Открыть модели проекта'); expect(f.open).not.toHaveBeenCalled();
    });
    it('embedding defaults by assignment, readiness and dimension without saving or reindexing', async () => {
        models = [model('wrong', {capability: 'embedding', dimension: 384, runtime: 'ollama', manifestSha256: 'c'.repeat(64)}), model('not-ready', {capability: 'embedding', dimension: 1024, runtime: 'ollama'}), model('right', {capability: 'embedding', dimension: 1024, runtime: 'ollama', manifestSha256: 'c'.repeat(64)})];
        models.unshift({...models[2], id: 'unassigned'}); vi.mocked(modelCatalogApi.list).mockImplementation(async () => ({items: models, assignedModelIds: models.slice(1).map(value => value.id)}));
        await render('embedding'); expect(embedding.modelId).toBe('right'); expect(projectEmbeddingApi.save).not.toHaveBeenCalled();
        await act(async () => embedding.choose(null)); await act(async () => embedding.refresh()); expect(embedding.modelId).toBeNull();
    });
    it('embedding preserves a saved selection and a previously saved empty selection', async () => {
        saved = {...saved, revision: 3, model: models[1]}; await render('embedding'); expect(embedding.modelId).toBe('second');
        saved = {...saved, model: null}; await act(async () => embedding.refresh()); expect(embedding.modelId).toBeNull(); expect(projectEmbeddingApi.save).not.toHaveBeenCalled();
    });
    it('learning resources offer only assigned, unarchived, usable chat or vision models', async () => {
        models = [model('unverified', {verificationSha256: null}), model('embedding', {capability: 'embedding'}), model('archived', {archivedAt: 'today'}), model('ready')];
        await render('resources'); expect(resources.models.map(value => value.id)).toEqual(['ready']);
    });
});
