import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modalAntd, uiNode } from './modal-actions.fixture';

const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture'), { modalUi } = await import('./modal-actions.fixture');
    return { hooks: adminSetupHooks(), ui: modalUi(), enabled: true, owner: 'alice', values: {} as Record<string, any> };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    const owner = h.owner; return { captureOwner: () => () => h.owner === owner };
} }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ useFeatureAvailability: () => ({ enabled: h.enabled, reason: 'Новые запуски выключены' }) }));
vi.mock('../src/features/SystemRoles/useSystemRole', () => ({ useSystemRole: () => h.values }));
vi.mock('../src/features/SystemRoles/RoleRunContent', () => ({ RoleRunContent: ({ run }: { run: { result?: { summary: string } } }) => run.result?.summary ?? null,
    rolePhaseLabel: (phase: string) => phase }));
vi.mock('antd', async () => {
    const ui = modalAntd(h.ui, (await import('react')).createElement);
    return { ...ui, Modal: Object.assign(ui.Modal, { confirm: vi.fn(() => ({ destroy: vi.fn() })) }),
        Checkbox: Object.assign(ui.Checkbox, { Group: ui.Checkbox }), Typography: { ...ui.Typography, Title: ui.Typography.Text } };
});
import { SystemRoleModal } from '../src/features/SystemRoles/SystemRoleModal';

const projectId = 'prj-legacy-context', modelId = 'model-legacy-chat', instruction = 'Проверь выбранный промпт.';
const currentDefinitionPin = 'd'.repeat(64), currentConsent = 'e'.repeat(64);
const selection = { projectId, instruction, diagnostics: [], targets: [{ kind: 'agent', id: 'agent-selected' }] };
const button = (text: string) => uiNode(h.ui, 'Button', text);
const render = () => {
    h.hooks.begin(); h.ui.nodes = [];
    const html = renderToStaticMarkup(createElement(SystemRoleModal, { id: 'agent-autoconfigurator', projectId,
        initialRunId: '12345678-1234-1234-1234-123456789abc', onClose: vi.fn() }));
    h.hooks.commit(); return html;
};
const reopen = () => { render(); expect(button('Подготовить контекст')).toBeDefined(); button('Вернуться к подготовке').onClick(); return render(); };
beforeEach(() => {
    h.hooks.dispose(); vi.clearAllMocks(); h.enabled = true; h.owner = 'alice';
    const run = { id: '12345678-1234-1234-1234-123456789abc', state: 'awaiting_review', phase: 'review', canApply: false, canCancel: true, canRollback: false,
        result: { kind: 'proposal', summary: 'Сохранённое старое предложение', findings: [], nextSteps: [],
            changes: [{ targetKey: 'agent:agent-selected', replacement: 'Полный новый выбранный промпт', explanation: 'Уточнение задачи.' }] },
        prepareAgain: { reason: 'definition_changed', selection: structuredClone(selection), modelId } };
    h.values = { overview: { definitions: [{ id: 'agent-autoconfigurator', description: 'Текущая роль', definitionPin: currentDefinitionPin,
        targets: ['agent', 'prompt'], diagnostics: [] }], models: [{ id: modelId, name: 'Текущая проверенная модель', pin: 'a'.repeat(64) }],
        targets: [{ kind: 'agent', id: 'agent-selected', name: 'Выбранный агент' }] }, history: [run], run, prepared: undefined,
        error: '', busy: false, uncertain: false, prepare: vi.fn(), start: vi.fn(), action: vi.fn(), replay: vi.fn(), invalidate: vi.fn(), refresh: vi.fn(), select: vi.fn() };
    vi.stubGlobal('crypto', { randomUUID: () => 'a2345678-1234-1234-1234-123456789abc' });
});
afterEach(() => { h.hooks.dispose(); vi.unstubAllGlobals(); });

describe('Legacy proposal continuation through the current role form', () => {
    it('reopens the original task as an editable draft without applying or starting it', () => {
        const html = reopen();
        expect(html).toContain('Сохранённое старое предложение');
        expect(h.ui.nodes.some(node => node.kind === 'Button' && node.text.includes('Применить'))).toBe(false);
        expect(uiNode(h.ui, 'TextArea').value).toBe(instruction);
        expect(h.ui.nodes.find(node => node.kind === 'Select' && node.props['aria-label'] === 'Модель системного агента')?.props.value).toBe(modelId);
        expect(h.ui.nodes.find(node => node.kind === 'Select' && node.props['aria-label'] === 'Цели системного агента')?.props.value).toEqual(['agent:agent-selected']);
        expect(h.values.prepare).not.toHaveBeenCalled(); expect(h.values.start).not.toHaveBeenCalled(); expect(h.values.action).not.toHaveBeenCalled();
    });
    it('keeps reopened input after current prepare fails and requires fresh consent before a new start', () => {
        reopen(); const edited = instruction + ' Сохрани назначение.';
        uiNode(h.ui, 'TextArea').onChange({ target: { value: edited } }); render();
        button('Подготовить контекст').onClick();
        expect(h.values.prepare).toHaveBeenCalledExactlyOnceWith({ ...selection, instruction: edited });
        h.values.error = 'Контекст не подготовлен. Введённое сохранено.'; render();
        expect(uiNode(h.ui, 'TextArea').value).toBe(edited); expect(h.values.start).not.toHaveBeenCalled();
        h.values.error = ''; h.values.prepared = { preview: 'Текущий контекст', definitionPin: currentDefinitionPin, consentDigest: currentConsent }; render();
        expect(uiNode(h.ui, 'Checkbox', 'Разрешаю').checked).toBe(false); expect(button('Запустить').disabled).toBe(true);
        uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); button('Запустить').onClick();
        expect(h.values.start).toHaveBeenCalledExactlyOnceWith({ ...selection, instruction: edited, requestId: 'a2345678-1234-1234-1234-123456789abc',
            modelId, expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: currentDefinitionPin, consentDigest: currentConsent });
        expect(h.values.action).not.toHaveBeenCalled(); expect(h.values.run.result.summary).toBe('Сохранённое старое предложение');
    });
    it('blocks retained new-start handlers after a flag or actor change while keeping the reopened input', () => {
        reopen(); h.values.prepared = { preview: 'Текущий контекст', definitionPin: currentDefinitionPin, consentDigest: currentConsent }; render();
        uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render(); const staleFlag = button('Запустить').onClick;
        h.enabled = false; render(); staleFlag(); expect(h.values.start).not.toHaveBeenCalled(); expect(uiNode(h.ui, 'TextArea').value).toBe(instruction);
        h.enabled = true; render(); uiNode(h.ui, 'Checkbox', 'Разрешаю').onChange({ target: { checked: true } }); render();
        const staleActor = button('Запустить').onClick; h.owner = 'bob'; staleActor();
        expect(h.values.start).not.toHaveBeenCalled(); expect(h.values.action).not.toHaveBeenCalled();
    });
});
