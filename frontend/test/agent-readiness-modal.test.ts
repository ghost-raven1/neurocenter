import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modalAntd, uiNode } from './modal-actions.fixture';
import { readinessItem, trial } from './agent-readiness.fixture';
import type { IAgentReadinessItem } from '../src/features/AgentCatalog/readinessTypes';
import type { IEvaluatedFeatureFlags } from '../src/features/FeatureFlags/types';
const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture'), { modalUi } = await import('./modal-actions.fixture');
    return { hooks: adminSetupHooks(), ui: modalUi(), push: vi.fn(), enabled: true, search: true };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.hooks.state }));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: h.push }) }));
vi.mock('antd', async () => {
    const element = (await import('react')).createElement, ui = modalAntd(h.ui, element);
    const Radio = Object.assign((props: Record<string, any>) => { h.ui.nodes.push({ kind: 'Radio', props, text: String(props.children) }); return element('label', null, props.children); }, { Group: ui.Radio.Group });
    return { ...ui, Radio, Tooltip: ({ children }: { children?: ReactNode }) => children };
});
import { AgentTrialModal } from '../src/features/AgentCatalog/AgentTrialModal';
import { FeatureAvailabilityContext } from '../src/features/FeatureFlags/FeatureAvailability';
import { featureFlagKeys } from '../src/features/FeatureFlags/types';
let item: IAgentReadinessItem, busy: boolean, loading: boolean, error: string, uncertain: boolean, checking: boolean;
const close = vi.fn(), refresh = vi.fn(), replay = vi.fn(), start = vi.fn(), cancel = vi.fn();
const render = () => {
    h.hooks.begin(); h.ui.nodes = [];
    const flags = Object.fromEntries(featureFlagKeys.map(key => [key, key === 'project_search' ? h.search : h.enabled]));
    const data = { flags, configured: flags, blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []])) } as IEvaluatedFeatureFlags;
    const html = renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, { value: { data, loading: false, error: null, refresh: async () => undefined } }, createElement(AgentTrialModal,
        { projectId: 'project/one', name: 'Ревьюер', item, busy, loading, error, uncertain, checking, onClose: close, onRefresh: refresh, onReplay: replay, onStart: start, onCancel: cancel })));
    h.hooks.commit(); return html;
};
const button = (label = 'Запустить испытание') => uiNode(h.ui, 'Button', label);
const choose = () => { uiNode(h.ui, 'Select').onChange('model-one'); render(); };
beforeEach(() => { h.hooks.dispose(); vi.clearAllMocks(); h.enabled = true; h.search = true; item = readinessItem(); busy = false; loading = false; error = ''; uncertain = false; checking = false; });
afterEach(() => h.hooks.dispose());
it('opening, selecting and rereading never start a model call; only the explicit button starts the selected configuration', () => {
    const html = render(); expect(html).toContain('может расходовать лимит провайдера'); expect(start).not.toHaveBeenCalled(); expect(button().disabled).toBe(false);
    choose(); expect(start).not.toHaveBeenCalled(); expect(button().disabled).toBe(false);
    button().onClick({}); expect(start).toHaveBeenCalledExactlyOnceWith('model-one', 'none', false);
});
it('fixed effective model is displayed without a replacement selector', () => {
    item = readinessItem({ eligibility: { ...item.eligibility, modelSelection: 'fixed', resolvedModelId: 'model-one' } });
    expect(render()).toContain('Закреплена в агенте'); expect(h.ui.nodes.some(node => node.kind === 'Select')).toBe(false);
    button().onClick({}); expect(start).toHaveBeenCalledExactlyOnceWith('model-one', 'none', false);
});
it('search is opt-in and requires a fresh explicit consent after switching modes', () => {
    render(); choose(); uiNode(h.ui, 'RadioGroup').onChange({ target: { value: 'project_search' } }); render();
    expect(button().disabled).toBe(true); button().onClick({}); expect(start).not.toHaveBeenCalled();
    uiNode(h.ui, 'Checkbox').onChange({ target: { checked: true } }); render(); button().onClick({}); expect(start).toHaveBeenLastCalledWith('model-one', 'project_search', true);
    uiNode(h.ui, 'RadioGroup').onChange({ target: { value: 'none' } }); render(); uiNode(h.ui, 'RadioGroup').onChange({ target: { value: 'project_search' } }); render(); expect(button().disabled).toBe(true);
});
it.each(['unavailable', 'removed'] as const)('fresh search eligibility %s keeps a visible switch back to a tool-less trial', state => {
    render(); choose(); uiNode(h.ui, 'RadioGroup').onChange({ target: { value: 'project_search' } }); render();
    uiNode(h.ui, 'Checkbox').onChange({ target: { checked: true } }); render(); expect(start).not.toHaveBeenCalled();
    item = { ...item, eligibility: { ...item.eligibility, tools: state === 'removed' ? [] : [{ kind: 'project_search', available: false, requiresConsent: true, reason: 'Индекс проекта изменился' }] } };
    const html = render(); expect(html).toContain(state === 'removed' ? 'Поиск данных проекта сейчас недоступен' : 'Индекс проекта изменился');
    expect(uiNode(h.ui, 'RadioGroup').disabled).toBe(false); expect(uiNode(h.ui, 'Radio', 'Также поиск').disabled).toBe(true);
    button().onClick({}); expect(start).not.toHaveBeenCalled(); expect(button().disabled).toBe(true);
    uiNode(h.ui, 'RadioGroup').onChange({ target: { value: 'none' } }); render(); expect(button().disabled).toBe(false); expect(start).not.toHaveBeenCalled();
    button().onClick({}); expect(start).toHaveBeenCalledExactlyOnceWith('model-one', 'none', false);
});
it('denied search is not offered; disabled feature cannot be invoked through a retained event handler', () => {
    item = readinessItem({ eligibility: { ...item.eligibility, tools: [{ kind: 'project_search', available: false, requiresConsent: false, reason: 'Чтение данных запрещено' }] } });
    expect(render()).toContain('Чтение данных запрещено'); expect(h.ui.nodes.some(node => node.kind === 'RadioGroup')).toBe(false);
    choose(); h.enabled = false; render(); expect(button().disabled).toBe(true); button().onClick({}); expect(start).not.toHaveBeenCalled();
});
it('switching off project search leaves plain trial available, but blocks chosen search and explains why', () => {
    render(); choose(); uiNode(h.ui, 'RadioGroup').onChange({ target: { value: 'project_search' } }); render(); uiNode(h.ui, 'Checkbox').onChange({ target: { checked: true } });
    h.search = false; expect(render()).toContain('выключено главным администратором'); expect(button().disabled).toBe(true);
    uiNode(h.ui, 'RadioGroup').onChange({ target: { value: 'none' } }); render(); expect(button().disabled).toBe(false);
});
it('running state offers owner-authorized stop and closing even after feature shutdown, with no new run', () => {
    item = readinessItem({ latestTrial: trial({ status: 'running', canCancel: true }) }); h.enabled = false;
    const html = render(); expect(html).toContain('Идёт испытание в чате'); expect(html).toContain('Можно закрыть окно'); expect(h.ui.nodes.some(node => node.kind === 'Select')).toBe(false);
    button('Остановить испытание').onClick(); expect(cancel).toHaveBeenCalledExactlyOnceWith(item.latestTrial); expect(start).not.toHaveBeenCalled();
    uiNode(h.ui, 'Modal').onCancel(); expect(close).toHaveBeenCalledOnce();
    item = readinessItem({ latestTrial: trial({ status: 'running', canCancel: false }) }); render(); expect(h.ui.nodes.some(node => node.kind === 'Button' && node.text === 'Остановить испытание')).toBe(false);
});
it('historical success is model-scoped with checks and pins; changed settings show stale instead of ready', () => {
    item = readinessItem({ latestTrial: trial() }); let html = render(); expect(html).toContain('Проверено в чате Нейроцентра'); expect(html).toContain('Модель проекта'); expect(html).toContain('Промпт передан модели'); expect(html).toContain('Настройки OpenCode подтверждаются мостом отдельно'); expect(html).toContain('c'.repeat(64));
    expect(start).not.toHaveBeenCalled(); item = readinessItem({ latestTrial: trial({ current: false, staleReason: 'Промпт изменён' }) }); html = render();
    expect(html).toContain('Предыдущая проверка устарела'); expect(html).toContain('Промпт изменён'); expect(html).not.toContain('Проверено в чате Нейроцентра');
});
it('a global revision mismatch is neutral while checking; unrelated fresh metadata restores proof without rewriting history', () => {
    item = readinessItem({ latestTrial: trial() }); checking = true; let html = render();
    expect(html).toContain('Проверяем актуальность'); expect(html).toContain('Последняя сохранённая квитанция'); expect(html).not.toContain('Проверено в чате Нейроцентра');
    expect(html).not.toContain('Предыдущая проверка устарела'); expect(button('Запустить ещё раз').disabled).toBe(true);
    button('Запустить ещё раз').onClick({}); expect(start).not.toHaveBeenCalled();
    item = { ...item, projectRevision: 4 }; checking = false; html = render(); expect(html).toContain('Проверено в чате Нейроцентра'); expect(item.latestTrial?.current).toBe(true);
});
it('lost acknowledgement has explicit idempotent replay and read recovery; it disables a new trial', () => {
    uncertain = true; error = 'Ответ потерян'; render(); expect(button().disabled).toBe(true); button().onClick({}); expect(start).not.toHaveBeenCalled();
    button('Повторить тот же запрос').onClick(); expect(replay).toHaveBeenCalledOnce(); button('Перечитать состояние').onClick(); expect(refresh).toHaveBeenCalledOnce();
    button('Закрыть').onClick(); expect(close).toHaveBeenCalledOnce();
});
it.each(['busy', 'loading', 'error'] as const)('%s blocks only new work while closing remains reachable', state => {
    render(); choose(); if (state === 'busy') busy = true; else if (state === 'loading') loading = true; else error = 'Metadata unavailable'; render();
    button().onClick({}); expect(start).not.toHaveBeenCalled(); expect(button().disabled).toBe(true); button('Закрыть').onClick(); expect(close).toHaveBeenCalledOnce();
});
it('unavailable model gives a direct project models action, never an implicit fallback', () => {
    item = readinessItem({ eligibility: { ...item.eligibility, canRun: false, reason: 'Назначьте доступную модель', models: [] } });
    expect(render()).toContain('Назначьте доступную модель'); expect(button().disabled).toBe(true); button('Открыть модели проекта').onClick();
    expect(close).toHaveBeenCalledOnce(); expect(h.push).toHaveBeenCalledExactlyOnceWith('/projects/project%2Fone?tab=store&catalogTab=models'); expect(start).not.toHaveBeenCalled();
});
