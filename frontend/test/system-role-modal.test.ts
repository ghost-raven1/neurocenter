import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modalAntd, uiNode } from './modal-actions.fixture';
const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture'), { modalUi } = await import('./modal-actions.fixture');
    return { hooks: adminSetupHooks(), ui: modalUi(), enabled: true, owner: 'alice', values: {} as Record<string, any> };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => { const owner = h.owner; return { captureOwner: () => () => h.owner === owner }; } }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ useFeatureAvailability: () => ({ enabled: h.enabled, reason: 'Функция выключена' }) }));
vi.mock('../src/features/SystemRoles/useSystemRole', () => ({ useSystemRole: vi.fn(() => h.values) }));
vi.mock('../src/features/SystemRoles/RoleRunContent', () => ({ RoleRunContent: () => null, rolePhaseLabel: (value: string) => value }));
vi.mock('antd', async () => {
    const element = (await import('react')).createElement, ui = modalAntd(h.ui, element);
    return { ...ui, Modal: Object.assign(ui.Modal, { confirm: vi.fn(() => ({ destroy: vi.fn() })) }), Checkbox: Object.assign(ui.Checkbox, { Group: ui.Checkbox }), Typography: { ...ui.Typography, Title: ui.Typography.Text } };
});
import { SystemRoleModal } from '../src/features/SystemRoles/SystemRoleModal';
import { useSystemRole } from '../src/features/SystemRoles/useSystemRole';
const render = (initialRunId?: string) => { h.hooks.begin(); h.ui.nodes = []; const html = renderToStaticMarkup(createElement(SystemRoleModal, { id: 'agent-ai-admin', projectId: 'prj-one', initialRunId, onClose: vi.fn() })); h.hooks.commit(); return html; };
const button = (text: string) => uiNode(h.ui, 'Button', text);
beforeEach(() => { h.hooks.dispose(); vi.clearAllMocks(); h.enabled = true; h.owner = 'alice'; h.values = {
    overview: { definitions: [{ id: 'agent-ai-admin', description: 'Diagnostics', targets: [], diagnostics: ['health'] }], models: [{ id: 'model-one', name: 'Model', pin: 'a'.repeat(64) }], targets: [] },
    history: [], run: null, prepared: undefined, error: '', busy: false, uncertain: false, prepare: vi.fn(), start: vi.fn(), action: vi.fn(), replay: vi.fn(), invalidate: vi.fn(), refresh: vi.fn(), select: vi.fn(),
}; vi.stubGlobal('crypto', { randomUUID: () => 'explicit-request' }); });
afterEach(() => { h.hooks.dispose(); vi.unstubAllGlobals(); });
const selectModelAndTask = () => { uiNode(h.ui, 'Select').onChange('model-one'); uiNode(h.ui, 'TextArea').onChange({ target: { value: 'Check current readiness' } }); render(); };
it('opening and preview do not call a model; explicit selected model+exact preview consent creates one pinned request', () => {
    render(); expect(h.values.start).not.toHaveBeenCalled(); selectModelAndTask();
    button('Подготовить контекст').onClick(); expect(h.values.prepare).toHaveBeenCalledExactlyOnceWith({ projectId: 'prj-one', instruction: 'Check current readiness', diagnostics: [], targets: [] }); expect(h.values.start).not.toHaveBeenCalled();
    h.values.prepared = { preview: 'Safe exact preview', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64) }; render(); expect(button('Запустить').disabled).toBe(true);
    uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); button('Запустить').onClick();
    expect(h.values.start).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'explicit-request', modelId: 'model-one', expectedModelPin: 'a'.repeat(64), consentDigest: 'b'.repeat(64), expectedDefinitionPin: 'c'.repeat(64) }));
});
it('retained handlers cannot start inference after a flag switch or actor switch', () => {
    render(); selectModelAndTask(); h.values.prepared = { preview: 'Safe', consentDigest: 'b'.repeat(64), definitionPin: 'c'.repeat(64) }; render(); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render();
    const stale = button('Запустить').onClick; h.enabled = false; render(); stale(); expect(h.values.start).not.toHaveBeenCalled();
    h.enabled = true; render(); const staleActor = button('Запустить').onClick; h.owner = 'bob'; staleActor(); expect(h.values.start).not.toHaveBeenCalled();
});
it('exact saved run can be reviewed and cancelled when new execution is disabled', () => {
    h.enabled = false; h.values.run = { id: 'selected-run', state: 'awaiting_review', canCancel: true };
    expect(render('selected-run')).toContain('История, отмена и откат'); expect(useSystemRole).toHaveBeenCalledWith('agent-ai-admin', 'prj-one', 'selected-run');
    button('Отменить запуск').onClick(); expect(h.values.action).toHaveBeenCalledWith('cancel'); expect(h.values.start).not.toHaveBeenCalled();
});
