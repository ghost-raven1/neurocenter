import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {flushSetup} from './admin-setup-hooks.fixture';
import {modalAntd, uiNode} from './modal-actions.fixture';
import {agent, assignment, bridge, catalog, delivery} from './agent-fixtures';
import type {IAgentCatalog, IAgentCatalogProps} from '../src/features/AgentCatalog/types';
import type {AgentCard} from '../src/features/AgentCatalog/AgentCard';
import type {AgentDetails} from '../src/features/AgentCatalog/AgentDetails';
import type {AgentEditModal} from '../src/features/AgentCatalog/AgentEditModal';
import type {ProjectAgentEditor} from '../src/features/AgentCatalog/ProjectAgentEditor';
import type {AgentTrialModal} from '../src/features/AgentCatalog/AgentTrialModal';
import {readinessItem, trial} from './agent-readiness.fixture';
import type {IAgentReadinessItem} from '../src/features/AgentCatalog/readinessTypes';
import type {IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
type Card = Parameters<typeof AgentCard>[0];
type Details = Parameters<typeof AgentDetails>[0];
type Editor = Parameters<typeof AgentEditModal>[0];
type ProjectEditor = Parameters<typeof ProjectAgentEditor>[0];
type Confirmation = {title: string; onOk: () => unknown; destroy: ReturnType<typeof vi.fn>};
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture'), {modalUi} = await import('./modal-actions.fixture');
    return {hooks: adminSetupHooks(), ui: modalUi(), scope: 'alice', flagsEnabled: true,
        user: {activeRole: 'Главный админ', userRoles: ['Главный админ'], projectRoles: [] as Array<{projectId: string; projectName: string; role: string}>},
        catalog: null as IAgentCatalog | null, loading: false, error: '', refresh: vi.fn(), navigate: vi.fn(), chat: vi.fn(), cards: [] as Card[],
        detail: undefined as Details | undefined, editor: undefined as Editor | undefined, projectEditor: undefined as ProjectEditor | undefined,
        trialModal: undefined as Parameters<typeof AgentTrialModal>[0] | undefined,
        readiness: {items: [] as IAgentReadinessItem[], loading: false, error: '', busy: false, uncertain: false, refresh: vi.fn(), replay: vi.fn(), start: vi.fn(), cancel: vi.fn()},
        confirmations: [] as Confirmation[], actions: {busy: false, error: '', notice: '', unconfirmed: false, mutate: vi.fn(), apply: vi.fn(), repeat: vi.fn(), recheck: vi.fn()}};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useMemo: h.hooks.memo, useEffect: h.hooks.effect}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: h.user}})}));
vi.mock('react-router-dom', () => ({useHistory: () => ({push: h.navigate})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.scope, captureOwner: () => () => true})}));
vi.mock('../src/features/AgentCatalog/useAgentCatalog', () => ({useAgentCatalog: () => ({catalog: h.catalog, loading: h.loading, error: h.error, refresh: h.refresh})}));
vi.mock('../src/features/AgentCatalog/useAgentActions', () => ({useAgentActions: () => h.actions}));
vi.mock('../src/features/AgentCatalog/useAgentReadiness', () => ({useAgentReadiness: () => h.readiness}));
vi.mock('../src/features/AgentCatalog/AgentTrialModal', () => ({AgentTrialModal: (props: Parameters<typeof AgentTrialModal>[0]) => {h.trialModal = props; return 'Испытание агента';}}));
vi.mock('../src/features/ModelChat/chatNavigation', () => ({openModelChat: h.chat}));
vi.mock('../src/features/McpBridge/BridgeConnection', () => ({BridgeConnection: () => null}));
vi.mock('../src/features/AgentCatalog/AgentCard', () => ({AgentCard: (props: Card) => { h.cards.push(props); return props.agent.name; }}));
vi.mock('../src/features/AgentCatalog/AgentDetails', () => ({AgentDetails: (props: Details) => { h.detail = props; return 'Подробности агента'; }}));
vi.mock('../src/features/AgentCatalog/AgentEditModal', () => ({AgentEditModal: (props: Editor) => { h.editor = props; return 'Редактор шаблона'; }}));
vi.mock('../src/features/AgentCatalog/ProjectAgentEditor', () => ({ProjectAgentEditor: (props: ProjectEditor) => { h.projectEditor = props; return 'Настройки проекта'; }}));
vi.mock('antd', async () => {
    const ui = modalAntd(h.ui, (await import('react')).createElement), content = ({children}: {children?: ReactNode}) => children;
    return {...ui, Col: content, Row: content, Tooltip: content, Typography: {...ui.Typography, Title: content},
        Empty: ({children, description}: {children?: ReactNode; description?: ReactNode}) => createElement('div', null, description, children),
        Modal: Object.assign(ui.Modal, {confirm: (props: Omit<Confirmation, 'destroy'>) => { const value = {...props, destroy: vi.fn()}; h.confirmations.push(value); return value; }})};
});
import {AgentCatalog} from '../src/features/AgentCatalog/AgentCatalog';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys} from '../src/features/FeatureFlags/types';

let props: IAgentCatalogProps;
const data = (): IEvaluatedFeatureFlags => ({flags: Object.fromEntries(featureFlagKeys.map(key => [key, h.flagsEnabled])),
    configured: Object.fromEntries(featureFlagKeys.map(key => [key, h.flagsEnabled])), blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []]))}) as IEvaluatedFeatureFlags;
function render() {
    h.hooks.begin(); h.ui.nodes = []; h.cards = []; h.detail = undefined; h.editor = undefined; h.projectEditor = undefined; h.trialModal = undefined;
    const html = renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, {value: {data: data(), loading: false, error: null, refresh: async () => undefined}}, createElement(AgentCatalog, props)));
    h.hooks.commit(); return html;
}
const start = () => { render(); return render(); };
const button = (text: string) => uiNode(h.ui, 'Button', text);
const card = () => h.cards[0];
beforeEach(() => {
    h.hooks.dispose(); vi.clearAllMocks(); h.scope = 'alice'; h.flagsEnabled = true; h.user = {activeRole: 'Главный админ', userRoles: ['Главный админ'], projectRoles: []};
    h.catalog = catalog(); h.loading = false; h.error = ''; h.confirmations = []; h.actions.busy = false; h.actions.error = ''; h.actions.notice = ''; h.actions.unconfirmed = false;
    h.readiness.items = []; h.readiness.loading = false; h.readiness.error = ''; h.readiness.busy = false; h.readiness.uncertain = false;
    h.refresh.mockResolvedValue(true); h.actions.mutate.mockResolvedValue(undefined); h.actions.apply.mockResolvedValue(undefined); h.actions.repeat.mockResolvedValue(undefined); h.actions.recheck.mockResolvedValue(undefined);
    props = {projectId: 'project-one', projectName: 'Alpha', embedded: false, isMain: true, canManage: true, bridge: bridge()};
});
afterEach(() => h.hooks.dispose());

describe('Agent setup: actual toolbar, pinned configuration and recovery actions', () => {
    it('server-chat trial is separate from native delivery and available before enabling with project level two', () => {
        props.canManage = false; props.bridge = {...bridge(), devicesReady: false}; h.readiness.items = [readinessItem({agentId: agent().id})]; start();
        expect(card().trialDisabled).toBe(false); expect(card().assignment?.enabled).toBe(false); card().onTrial?.(); render();
        expect(h.trialModal?.name).toBe('Ревьюер'); expect(h.actions.apply).not.toHaveBeenCalled(); expect(h.readiness.start).not.toHaveBeenCalled();
        h.trialModal!.onStart('model-one', 'project_search', true); expect(h.readiness.start).toHaveBeenCalledExactlyOnceWith(h.readiness.items[0], 'model-one', 'project_search', true);
        h.trialModal!.onCancel(trial()); expect(h.readiness.cancel).toHaveBeenCalledExactlyOnceWith(agent().id, trial());
        h.trialModal!.onRefresh(); h.trialModal!.onReplay(); expect(h.readiness.refresh).toHaveBeenCalledOnce(); expect(h.readiness.replay).toHaveBeenCalledOnce();
        h.trialModal!.onClose(); render(); expect(h.trialModal).toBeUndefined();
    });
    it('unconfirmed metadata disables the entrypoint, and project observers or removed assignments have no trial action', () => {
        start(); expect(card().trialDisabled).toBe(true); h.readiness.items = [readinessItem({agentId: agent().id})]; props.isMain = false;
        h.user = {activeRole: 'Наблюдатель', userRoles: ['Наблюдатель'], projectRoles: [{projectId: 'project-one', projectName: 'Alpha', role: 'Наблюдатель'}]}; render(); expect(card().onTrial).toBeUndefined();
        h.catalog = catalog({assignments: [assignment({removed: true})]}); props.isMain = true; h.user.activeRole = 'Главный админ'; h.user.userRoles = ['Главный админ']; render(); expect(card().onTrial).toBeUndefined();
    });
    it('details opens a single trial panel and owner changes close it; read errors remain recoverable', () => {
        h.readiness.items = [readinessItem({agentId: agent().id})]; start(); card().onView(); render(); h.detail!.onTrial?.(); render();
        expect(h.detail).toBeUndefined(); expect(h.trialModal).toBeDefined(); h.scope = 'bob'; render(); render(); expect(h.trialModal).toBeUndefined();
        h.readiness.error = 'Trials offline'; expect(render()).toContain('Состояние испытаний не обновилось'); button('Перечитать испытания').onClick(); expect(h.readiness.refresh).toHaveBeenCalledOnce();
    });
    it('out-of-order catalog/readiness refresh checks proof neutrally until unrelated revision is confirmed', () => {
        h.readiness.items = [readinessItem({agentId: agent().id, latestTrial: trial()})]; start(); expect(card().trialChecking).toBe(false);
        h.catalog = catalog({revision: 4}); render(); expect(card().trialChecking).toBe(true); card().onTrial?.(); render(); expect(h.trialModal?.checking).toBe(true);
        h.readiness.items = [{...h.readiness.items[0], projectRevision: 4}]; render(); expect(card().trialChecking).toBe(false); expect(h.trialModal?.checking).toBe(false); expect(h.trialModal?.item.latestTrial?.current).toBe(true);
    });
    it('offers an explicit retry during initial load failure and keeps stale data visibly unconfirmed', async () => {
        h.catalog = null; h.loading = true; expect(start()).toContain('role="status"'); expect(h.cards).toEqual([]); h.loading = false; h.error = 'Сервер недоступен';
        expect(render()).toContain('Агенты не загружены'); button('Повторить').onClick(); expect(h.refresh).toHaveBeenCalledOnce();
        h.catalog = catalog(); expect(render()).toContain('показаны предыдущие данные'); card().onAssign(); expect(h.actions.mutate).not.toHaveBeenCalled();
        button('Обновить').onClick(); expect(h.refresh).toHaveBeenCalledTimes(2); await flushSetup();
    });
    it('recovery repeats the saved request or rereads server truth without silently mutating a card', async () => {
        h.actions.unconfirmed = true; h.actions.error = 'Нет подтверждения'; h.actions.notice = 'Операция уже сохранена'; expect(start()).toContain('Операция уже сохранена');
        button('Повторить запрос').onClick(); button('Перечитать состояние').onClick(); await flushSetup(); expect(h.actions.repeat).toHaveBeenCalledOnce(); expect(h.actions.recheck).toHaveBeenCalledOnce();
        card().onAssign(); expect(h.actions.mutate).not.toHaveBeenCalled(); h.actions.busy = true; render(); expect(button('Повторить запрос').disabled).toBe(true); expect(button('Перечитать состояние').disabled).toBe(true);
    });
    it('search, project-only and archive filters remain actionable and reset to the complete catalog', () => {
        const second = agent({id: 'other', name: 'Планировщик', slug: 'nc-planner'}), archived = agent({id: 'archived', name: 'Архивный', archivedAt: '2026-10-21'});
        h.catalog = catalog({items: [agent(), second, archived]}); props.embedded = true; start(); expect(h.cards.map(item => item.agent.id)).toEqual([agent().id]);
        uiNode(h.ui, 'Checkbox', 'Только в проекте').onChange({target: {checked: false}}); render(); expect(h.cards.map(item => item.agent.id)).toEqual([agent().id, 'other']);
        uiNode(h.ui, 'Checkbox', 'Показывать архив').onChange({target: {checked: true}}); render(); expect(h.cards).toHaveLength(3);
        uiNode(h.ui, 'Search').onChange({target: {value: 'Отсутствует'}}); expect(render()).toContain('По этому запросу агенты не найдены'); button('Показать все агенты').onClick(); render(); expect(h.cards).toHaveLength(3);
        uiNode(h.ui, 'Checkbox', 'Показывать архив').onChange({target: {checked: false}}); render(); expect(h.cards).toHaveLength(2);
    });
    it('empty project and global catalogs explain their different next actions', () => {
        h.catalog = catalog({items: [], assignments: []}); props.embedded = true; expect(start()).toContain('В проект пока не добавлены агенты'); button('Показать все агенты').onClick(); expect(render()).toContain('В каталоге пока нет агентов');
        props.projectId = undefined; props.projectName = undefined; expect(render()).toContain('Агенты команды'); expect(h.ui.nodes.some(node => node.kind === 'Checkbox' && node.text === 'Только в проекте')).toBe(false);
    });
    it('new template, assets navigation and private group launch have direct explicit entrypoints', () => {
        start(); button('Из ассетов').onClick(); expect(h.navigate).toHaveBeenCalledWith('/assets'); button('Чат с агентами').onClick(); expect(h.chat).toHaveBeenCalledExactlyOnceWith({projectId: 'project-one', group: true});
        button('Добавить агента').onClick(); render(); expect(h.editor?.agent).toBeUndefined(); h.editor!.onClose(); render(); expect(h.editor).toBeUndefined();
        props.isMain = false; props.canManage = false; h.user = {activeRole: 'Наблюдатель', userRoles: ['Наблюдатель'], projectRoles: [{projectId: 'project-one', projectName: 'Alpha', role: 'Наблюдатель'}]}; render();
        expect(h.ui.nodes.some(node => node.kind === 'Button' && ['Добавить агента', 'Из ассетов', 'Чат с агентами', 'Применить настройки'].includes(node.text))).toBe(false);
    });
    it('template save only clears search/project filter after its authoritative refresh; failure stays in the editor', async () => {
        props.embedded = true; start(); uiNode(h.ui, 'Search').onChange({target: {value: 'Ревьюер'}}); card().onEdit(); render(); expect(h.editor?.agent?.id).toBe(agent().id);
        h.refresh.mockResolvedValueOnce(false); await expect(h.editor!.onSaved()).rejects.toThrow('Ваш текст остался в форме'); render(); expect(uiNode(h.ui, 'Search').value).toBe('Ревьюер'); expect(h.editor).toBeDefined();
        await h.editor!.onSaved(); render(); expect(uiNode(h.ui, 'Search').value).toBe(''); expect(uiNode(h.ui, 'Checkbox', 'Только в проекте').checked).toBe(false);
        h.editor!.onClose(); render(); expect(h.editor).toBeUndefined();
    });
    it('details use the immutable project card when the common template disappeared, and close cleanly', () => {
        const pinned = agent({name: 'Сохранённое имя'}); h.catalog = catalog({items: [], assignments: [assignment({card: pinned})]}); start(); card().onView(); render(); expect(h.detail?.agent.name).toBe('Сохранённое имя'); expect(h.detail?.assignment?.agentId).toBe(pinned.id);
        h.detail!.onClose(); render(); expect(h.detail).toBeUndefined();
    });
    it('assign and toggle carry exact pins and current revision, reassign uses the removed project version', async () => {
        const latest = agent({version: 2, manifest: 'e'.repeat(64)}); h.catalog = catalog({items: [latest], assignments: []}); start(); card().onAssign(); await flushSetup(); expect(h.actions.mutate).toHaveBeenLastCalledWith({kind: 'assign', agent: latest, revision: 3, patch: undefined});
        const pinned = assignment({removed: true}); h.catalog = catalog({items: [latest], assignments: [pinned]}); render(); card().onAssign(); await flushSetup(); expect(h.actions.mutate).toHaveBeenLastCalledWith({kind: 'assign', agent: pinned.card, revision: 3, patch: undefined});
        h.catalog = catalog(); render(); card().onToggle(); await flushSetup(); expect(h.actions.mutate).toHaveBeenLastCalledWith({kind: 'configure', agent: agent(), revision: 3, patch: {enabled: true}});
        h.actions.mutate.mockRejectedValueOnce(Error('Controller reports this failure')); card().onAssign(); await flushSetup(); expect(h.actions.mutate).toHaveBeenCalledTimes(4);
    });
    it('project editor pins its opened revision, forwards actual overrides, and can close without a write', async () => {
        start(); card().onConfigure(); render(); expect(h.projectEditor).toMatchObject({projectId: 'project-one', revision: 3}); const editor = h.projectEditor!;
        h.catalog = catalog({revision: 9}); render(); const patch = {enabled: true, overrides: {prompt: 'Проектные инструкции'}}; await editor.onSave(agent(), patch, 3);
        expect(h.actions.mutate).toHaveBeenCalledExactlyOnceWith({kind: 'configure', agent: agent(), patch, revision: 3}); h.projectEditor!.onClose(); render(); expect(h.projectEditor).toBeUndefined();
    });
    it('remove uses a confirmation with the pinned card; failed controller response needs an explicit retry', async () => {
        start(); card().onRemove(); expect(h.actions.mutate).not.toHaveBeenCalled(); expect(h.confirmations[0].title).toContain('Удалить «Ревьюер» из проекта');
        h.actions.mutate.mockRejectedValueOnce(Error('Conflict already reported')); await h.confirmations[0].onOk(); expect(h.actions.mutate).toHaveBeenCalledExactlyOnceWith({kind: 'remove', agent: assignment().card, revision: 3});
        card().onRemove(); await h.confirmations[1].onOk(); expect(h.actions.mutate).toHaveBeenCalledTimes(2); expect(h.actions.mutate).toHaveBeenLastCalledWith({kind: 'remove', agent: assignment().card, revision: 3});
    });
    it('explicit template update changes only version/manifest and preserves project override responsibility', async () => {
        const latest = agent({version: 2, manifest: 'e'.repeat(64)}); h.catalog = catalog({items: [latest]}); start(); card().onUpdate(); expect(h.confirmations[0].title).toBe('Обновить шаблон v1 → v2?'); h.confirmations[0].onOk(); await flushSetup();
        expect(h.actions.mutate).toHaveBeenCalledExactlyOnceWith({kind: 'configure', agent: assignment().card, revision: 3, patch: {version: 2, manifest: latest.manifest}});
    });
    it.each(['loading', 'error', 'unconfirmed', 'revision'] as const)('%s prevents card writes while state is unconfirmed', async reason => {
        if (reason === 'loading') h.loading = true; else if (reason === 'error') h.error = 'Read failed'; else if (reason === 'unconfirmed') h.actions.unconfirmed = true; else h.catalog = catalog({revision: null});
        start(); card().onAssign(); card().onToggle(); await flushSetup(); expect(h.actions.mutate).not.toHaveBeenCalled();
    });
    it('unassigned cards do not fabricate configure/remove/update actions', () => {
        h.catalog = catalog({assignments: []}); start(); card().onConfigure(); card().onToggle(); card().onRemove(); card().onUpdate(); render(); expect(h.projectEditor).toBeUndefined(); expect(h.confirmations).toEqual([]); expect(h.actions.mutate).not.toHaveBeenCalled();
    });
    it('owner/project transition closes forms, clears filters and destroys its old confirmation', () => {
        start(); const current = card(); current.onView(); current.onEdit(); current.onConfigure(); current.onRemove(); uiNode(h.ui, 'Search').onChange({target: {value: 'Ревьюер'}}); uiNode(h.ui, 'Checkbox', 'Показывать архив').onChange({target: {checked: true}}); render();
        expect(h.detail).toBeDefined(); expect(h.editor).toBeDefined(); expect(h.projectEditor).toBeDefined(); h.scope = 'bob'; props.projectId = 'project-two'; props.embedded = true; render(); render();
        expect(h.detail).toBeUndefined(); expect(h.editor).toBeUndefined(); expect(h.projectEditor).toBeUndefined(); expect(uiNode(h.ui, 'Search').value).toBe(''); expect(uiNode(h.ui, 'Checkbox', 'Показывать архив').checked).toBe(false); expect(h.confirmations[0].destroy).toHaveBeenCalledOnce();
    });
    it('only the current folder/revision pending delivery blocks apply; cleanup remains available when agents are off', async () => {
        h.catalog = catalog({deliveries: [delivery({deviceId: 'other', state: 'running'}), delivery({bindingId: 'other', state: 'running'}), delivery({instanceId: 'other', state: 'running'}), delivery({revision: 2, state: 'running'}), delivery()]});
        start(); expect(button('Применить настройки').disabled).toBe(false); button('Применить настройки').onClick({}); expect(h.actions.apply).toHaveBeenCalledOnce();
        h.catalog = catalog({deliveries: [delivery({state: 'running'})]}); render(); expect(button('Применить настройки')).toMatchObject({disabled: true, loading: true}); button('Применить настройки').onClick({}); expect(h.actions.apply).toHaveBeenCalledOnce();
        h.flagsEnabled = false; h.catalog = catalog({assignments: [assignment({enabled: true})]}); render(); expect(button('Применить настройки').disabled).toBe(true);
        h.catalog = catalog({assignments: [assignment({removed: true})]}); expect(render()).toContain('Ожидают удаления из OpenCode: Ревьюер'); expect(button('Применить настройки').disabled).toBe(false); button('Применить настройки').onClick({}); await flushSetup(); expect(h.actions.apply).toHaveBeenCalledTimes(2);
    });
    it('zero revision and disconnected bridge explain why apply is unavailable, resolved removal clears cleanup notice', () => {
        h.catalog = catalog({revision: 0}); start(); expect(button('Применить настройки').disabled).toBe(true); props.bridge = {...bridge(), devicesReady: false}; h.catalog = catalog(); expect(render()).toContain('Дождитесь проверки компьютера'); expect(button('Применить настройки').disabled).toBe(true);
        props.bridge = bridge(); const receipt = delivery(); receipt.result = {...receipt.result, agents: []}; h.catalog = catalog({assignments: [assignment({removed: true})], deliveries: [receipt]}); expect(render()).not.toContain('Ожидают удаления из OpenCode');
    });
    it('archive refresh and unmount dispose keep reading separate from mutation', async () => {
        start(); card().onArchived(); await flushSetup(); expect(h.refresh).toHaveBeenCalledOnce(); card().onRemove(); const confirmation = h.confirmations[0]; h.hooks.dispose(); expect(confirmation.destroy).toHaveBeenCalledOnce(); expect(h.actions.mutate).not.toHaveBeenCalled();
    });
});
