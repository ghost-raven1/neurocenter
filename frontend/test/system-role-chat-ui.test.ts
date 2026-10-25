import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modalAntd, uiNode } from './modal-actions.fixture';
import type { RoleProjectContextGrant } from '../src/features/SystemRoles/types';

const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture'), { modalUi } = await import('./modal-actions.fixture');
    return { hooks: adminSetupHooks(), ui: modalUi(), enabled: true, owner: 'alice', values: {} as Record<string, any>, action: vi.fn(), picker: undefined as any };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => { const owner = h.owner; return { captureOwner: () => () => h.owner === owner }; } }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ useFeatureAvailability: () => ({ enabled: h.enabled, reason: 'Функция выключена' }) }));
vi.mock('../src/features/SystemRoles/RoleRunContent', () => ({ RoleRunContent: () => createElement('div', null, 'Точные измерения и изменения'), rolePhaseLabel: (phase: string) => phase }));
vi.mock('../src/features/SystemRoleChat/McpTaskPicker', () => ({ McpTaskPicker: (props: unknown) => { h.picker = props; return null; } }));
vi.mock('antd', async () => {
    const element = (await import('react')).createElement, ui = modalAntd(h.ui, element);
    return { ...ui, Modal: Object.assign(ui.Modal, { confirm: vi.fn(() => ({ destroy: vi.fn() })) }), Checkbox: Object.assign(ui.Checkbox, { Group: ui.Checkbox }) };
});
import { ServiceComposer } from '../src/features/SystemRoleChat/ServiceComposer';
import { ServiceTurnContent } from '../src/features/SystemRoleChat/ServiceTurnContent';
import { Modal } from 'antd';

const render = (projectId = 'prj-one') => { h.hooks.begin(); h.ui.nodes = []; const html = renderToStaticMarkup(createElement(ServiceComposer, { value: h.values as any, projectId })); h.hooks.commit(); return html; };
const button = (text: string) => uiNode(h.ui, 'Button', text);
const field = (kind: string, label: string) => h.ui.nodes.find(node => node.kind === kind && node.props['aria-label'] === label)!.props;
const fill = () => { field('Select', 'Модель сервисного чата').onChange('model-one'); field('TextArea', 'Задача сервисного чата').onChange({ target: { value: 'Проверь текущую готовность' } }); render(); };
const projectContext: RoleProjectContextGrant = { scope: 'project-index', projectId: 'prj-one', projectName: 'Мой проект', identity: 'index-one', recipients: ['agent-coordinator', 'agent-ai-admin'], generation: 'generation-one', snapshot: 'snapshot-one' };
const preview = (withProjectContext = false) => { h.values.prepared = { dialogId: 'dialog-one', agentId: 'agent-coordinator', selection: { projectId: 'prj-one', instruction: 'Проверь текущую готовность', diagnostics: [], targets: [] }, prepared: { preview: 'Показан выбранный контекст', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64), ...(withProjectContext ? { projectContext } : {}) } }; render(); };
beforeEach(() => {
    h.hooks.dispose(); vi.clearAllMocks(); h.enabled = true; h.owner = 'alice'; h.values = {
        overview: { definitions: [{ id: 'agent-coordinator', targets: ['prompt'], diagnostics: ['project'] }, { id: 'agent-ai-admin', targets: [], diagnostics: ['health'] }], models: [{ id: 'model-one', name: 'Model', pin: 'a'.repeat(64) }], targets: [] },
        detail: undefined, prepared: undefined, busy: false, receipt: undefined, prepare: vi.fn(), start: vi.fn(), invalidate: vi.fn(),
    };
});
afterEach(() => { h.hooks.dispose(); });
it('defaults to Coordinator and requires an explicit per-task model and exact context consent before sending', () => {
    const html = render(); expect(html).toContain('до трёх системных агентов'); expect(field('Select', 'Системный агент').value).toBe('agent-coordinator'); expect(field('Select', 'Модель сервисного чата').value).toBeUndefined();
    expect(button('Проверить контекст').disabled).toBe(true); expect(h.values.start).not.toHaveBeenCalled(); fill(); button('Проверить контекст').onClick();
    expect(h.values.prepare).toHaveBeenCalledExactlyOnceWith('agent-coordinator', { projectId: 'prj-one', instruction: 'Проверь текущую готовность', diagnostics: [], targets: [] }, false, 'model-one');
    preview(); expect(button('Отправить').disabled).toBe(true); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); button('Отправить').onClick();
    expect(h.values.start).toHaveBeenCalledExactlyOnceWith('model-one');
});
it('editing a task invalidates consent synchronously and fences a retained submit handler', () => {
    render(); fill(); preview(); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); const old = button('Отправить').onClick;
    field('TextArea', 'Задача сервисного чата').onChange({ target: { value: 'Другая задача' } }); old(); expect(h.values.start).not.toHaveBeenCalled();
    render(); expect(button('Отправить').disabled).toBe(true); expect(field('TextArea', 'Задача сервисного чата').value).toBe('Другая задача');
});
it('a refreshed model pin clears consent and invalidates a retained submit handler', () => {
    render(); fill(); preview(true); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); const old = button('Отправить').onClick;
    h.values.overview.models[0].pin = 'd'.repeat(64); render(); old(); expect(h.values.start).not.toHaveBeenCalled(); render(); expect(button('Отправить').disabled).toBe(true);
});
it('retained handlers cannot start a paid call after flag-off or an actor switch', () => {
    render(); fill(); preview(); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); const old = button('Отправить').onClick;
    h.enabled = false; expect(render()).toContain('История, проверка отправки'); old(); expect(h.values.start).not.toHaveBeenCalled();
    h.enabled = true; render(); const staleActor = button('Проверить контекст').onClick; h.owner = 'bob'; staleActor(); expect(h.values.prepare).not.toHaveBeenCalled();
});
it('follow-up context is opt-in and shown only for completed answers in this selected private dialogue', () => {
    expect(render()).not.toContain('Добавить завершённые ответы');
    h.values.detail = { turns: [{ run: { state: 'awaiting_review', result: { summary: 'Own completed proposal' } } }] }; render(); fill();
    expect(uiNode(h.ui, 'Checkbox', 'Добавить завершённые ответы').checked).toBe(false);
    uiNode(h.ui, 'Checkbox', 'Добавить завершённые ответы').onChange({ target: { checked: true } }); render(); button('Проверить контекст').onClick();
    expect(h.values.prepare).toHaveBeenLastCalledWith('agent-coordinator', expect.any(Object), true, 'model-one');
});
it('an unavailable catalog explains setup while retaining the entered task', () => {
    render(); fill(); h.values.overview.models = []; const html = render(); expect(html).toContain('Подключите модель'); expect(field('TextArea', 'Задача сервисного чата').value).toBe('Проверь текущую готовность'); expect(button('Проверить контекст').disabled).toBe(true);
});
it('changing roles clears selected context and requires a fresh preview', () => {
    render(); fill(); preview(true); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); field('Select', 'Системный агент').onChange('agent-ai-admin');
    render(); expect(field('Select', 'Системный агент').value).toBe('agent-ai-admin'); expect(button('Отправить').disabled).toBe(true); button('Проверить контекст').onClick();
    expect(h.values.prepare).toHaveBeenLastCalledWith('agent-ai-admin', expect.objectContaining({ diagnostics: [], targets: [] }), false, 'model-one');
});
it('includes described search in the existing consent while clearly showing scope, recipients and the shared call budget', () => {
    render(); fill(); preview(true); const html = render();
    expect(html).toContain('поиск охватывает весь индекс проекта'); expect(html).toContain('он не ограничивает пути в индексе'); expect(html).toContain('Фрагменты могут получить: Координатор, AI-админ.');
    expect(html).toContain('Не более одного поиска за запуск'); expect(html).toContain('общий лимит вызовов модели'); expect(html).toContain('Найденные фрагменты станут известны после запуска');
    expect(html).not.toContain('Другие чаты и файлы не добавляются автоматически'); expect(uiNode(h.ui, 'Checkbox', 'Разрешаю').children).toContain('результаты описанного поиска');
    expect(button('Отправить').disabled).toBe(true); expect(h.values.start).not.toHaveBeenCalled();
    uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); button('Отправить').onClick(); expect(h.values.start).toHaveBeenCalledExactlyOnceWith('model-one');
});
it('changing project clears whole-index consent and fences a retained send handler', () => {
    render(); fill(); preview(true); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); const old = button('Отправить').onClick;
    render('prj-two'); old(); expect(h.values.start).not.toHaveBeenCalled(); render('prj-two');
    expect(uiNode(h.ui, 'Checkbox', 'Разрешаю').checked).toBe(false); expect(button('Отправить').disabled).toBe(true);
});
it('only explicitly selected actual MCP capabilities enter preparation and changing them revokes consent', () => {
    render(); fill(); const mcp = [{ runtime: 'server', assetId: 'asset-one', version: 1, manifest: 'd'.repeat(64), discoveryId: 'discovery-one', tools: [{ name: 'search', schemaDigest: 'e'.repeat(64) }] }];
    expect(h.picker.value).toEqual([]); h.picker.onChange(mcp); render(); button('Проверить контекст').onClick(); expect(h.values.prepare).toHaveBeenLastCalledWith('agent-coordinator', expect.objectContaining({ mcp }), false, 'model-one');
    preview(); expect(h.ui.nodes.find(node => node.kind === 'Button' && node.text.includes('Отправить'))!.text).toContain('до 11 вызовов модели');
    uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); const old = button('Отправить').onClick; h.picker.onChange([]); old(); expect(h.values.start).not.toHaveBeenCalled();
});
it('saved cancellation and rollback remain available flag-off while applying requires explicit owner confirmation', async () => {
    const turn: any = { id: 'turn-one', agentId: 'agent-coordinator', instruction: 'Own task', run: { phase: 'awaiting_review', result: { summary: 'Compact answer', delegations: [{ roleId: 'agent-ai-admin', state: 'succeeded' }, { roleId: 'agent-indexer', state: 'failed' }] }, canCancel: true, canApply: true, canRollback: true } };
    const show = () => { h.hooks.begin(); h.ui.nodes = []; const html = renderToStaticMarkup(createElement(ServiceTurnContent, { turn, busy: false, onAction: h.action })); h.hooks.commit(); return html; };
    h.enabled = false; const html = show(); expect(html).toContain('Compact answer'); expect(html).toContain('Ответ получен'); expect(html).toContain('Не завершено'); expect(html).toContain('Измерения, предложения и этапы');
    expect(button('Применить').disabled).toBe(true); button('Отменить').onClick(); expect(h.action).toHaveBeenCalledWith(turn, 'cancel');
    button('Откатить').onClick(); expect(h.action).toHaveBeenCalledTimes(1); await (vi.mocked(Modal.confirm).mock.calls.at(-1)![0].onOk as () => unknown)(); expect(h.action).toHaveBeenLastCalledWith(turn, 'rollback');
    h.enabled = true; show(); button('Применить').onClick(); await (vi.mocked(Modal.confirm).mock.calls.at(-1)![0].onOk as () => unknown)(); expect(h.action).toHaveBeenLastCalledWith(turn, 'apply');
});
