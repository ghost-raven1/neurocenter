import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredSetup, flushSetup} from './admin-setup-hooks.fixture';
import {modalAntd, uiNode} from './modal-actions.fixture';
import {participant} from './model-chat-fixtures';
import type {IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import type {IChatResearchChoices, IModelChatParticipant} from '../src/features/ModelChat/types';
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture'), {modalUi} = await import('./modal-actions.fixture');
    const owner = {value: 'alice', active: true};
    return {hooks: adminSetupHooks(), ui: modalUi(), owner, enabled: true, save: vi.fn(), close: vi.fn(),
        capture: () => { const key = owner.value; return () => owner.active && owner.value === key; }};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: h.hooks.state, useEffect: h.hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner: h.capture})}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {agents: vi.fn(), researchChoices: vi.fn(), send: vi.fn(), researchStep: vi.fn()}}));
vi.mock('antd', async () => ({...modalAntd(h.ui, (await import('react')).createElement), Tooltip: ({children}: {children: ReactNode}) => children}));
import {ChatParticipantsEditor} from '../src/features/ModelChat/ChatParticipantsEditor';
import {ChatResearchControls} from '../src/features/ModelChat/ChatResearchControls';
import {useChatResearch} from '../src/features/ModelChat/useChatResearch';
import {modelChatApi} from '../src/features/ModelChat/api';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys} from '../src/features/FeatureFlags/types';
const flags = (): IEvaluatedFeatureFlags => ({flags: Object.fromEntries(featureFlagKeys.map(key => [key, h.enabled])),
    configured: Object.fromEntries(featureFlagKeys.map(key => [key, h.enabled])), blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []]))}) as IEvaluatedFeatureFlags;
const choices = (patch: Partial<IChatResearchChoices> = {}): IChatResearchChoices => ({project: {available: true},
    external: [{assetId: 'exa', name: 'Exa', version: 3, manifest: 'a'.repeat(64), available: true}, {assetId: 'old', name: 'Old', version: 1, manifest: 'b'.repeat(64), available: false, reason: 'Снят с проекта'}],
    limits: {stepsPerRecipient: 6, externalCallsPerRound: 16, toolOutputBytes: 65536, gatheredTextBytes: 98304, roundTimeoutMs: 900000}, ...patch});
let props: Parameters<typeof ChatParticipantsEditor>[0], projectId: string | undefined, disabled: boolean, research: ReturnType<typeof useChatResearch>;
const render = (node: ReactNode) => {
    h.hooks.begin(); h.ui.nodes = [];
    const html = renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, {value: {data: flags(), loading: false, error: null, refresh: async () => undefined}}, node));
    h.hooks.commit(); return html;
};
const roster = () => render(createElement(ChatParticipantsEditor, props));
function ResearchHarness() { research = useChatResearch('model-one', projectId, 'chat-one', h.capture); return createElement(ChatResearchControls, {value: research, disabled, projectId}); }
const controls = () => render(createElement(ResearchHarness));
const checkbox = (label: string) => uiNode(h.ui, 'Checkbox', label);
const button = (label: string) => uiNode(h.ui, 'Button', label);
beforeEach(() => {
    h.hooks.dispose(); vi.resetAllMocks(); h.owner.value = 'alice'; h.owner.active = true; h.enabled = true; disabled = false; projectId = 'project-one';
    props = {modelId: 'model-one', projectId: 'project-one', saving: false, onSave: h.save, onClose: h.close}; h.save.mockResolvedValue(true);
    vi.mocked(modelChatApi.agents).mockResolvedValue([participant()]); vi.mocked(modelChatApi.researchChoices).mockResolvedValue(choices());
});
afterEach(() => h.hooks.dispose());

describe('Chat participant setup: retry, saved roster recovery and ownership', () => {
    it('failed roster load exposes a real retry, aborts its predecessor and permits an inline save after selection', async () => {
        props.inline = true; vi.mocked(modelChatApi.agents).mockRejectedValueOnce(Error('Временный отказ')); roster(); await flushSetup(); expect(roster()).toContain('Временный отказ'); expect(button('Создать группу').disabled).toBe(true);
        const oldSignal = vi.mocked(modelChatApi.agents).mock.calls[0][2]; button('Повторить').onClick(); roster(); await flushSetup(); roster(); expect(oldSignal.aborted).toBe(true); expect(modelChatApi.agents).toHaveBeenCalledTimes(2);
        checkbox('Разработчик').onChange({target: {checked: true}}); roster(); expect(button('Создать группу').disabled).toBe(false); button('Создать группу').onClick(); await flushSetup(); expect(h.save).toHaveBeenCalledExactlyOnceWith(['agent-dev']); expect(h.close).toHaveBeenCalledOnce();
    });
    it('joining requires at least one agent, while editing a saved empty group preserves history and permits an empty roster', async () => {
        props = {...props, participants: [], joining: true}; roster(); await flushSetup(); expect(roster()).toContain('Добавить агентов в диалог'); expect(uiNode(h.ui, 'Modal').okButtonProps.disabled).toBe(true);
        props.joining = false; expect(roster()).toContain('история сохранится даже без участников'); expect(uiNode(h.ui, 'Modal').okButtonProps.disabled).toBe(false); uiNode(h.ui, 'Modal').onOk(); await flushSetup(); expect(h.save).toHaveBeenCalledExactlyOnceWith([]);
    });
    it('inline cancel uses no mutation, the empty project explains where to add agents, and parent errors stay visible', async () => {
        props.inline = true; props.error = 'Состав изменён на сервере'; vi.mocked(modelChatApi.agents).mockResolvedValueOnce([]); roster(); await flushSetup(); const html = roster(); expect(html).toContain('Новая группа агентов'); expect(html).toContain('В проект пока не добавлены агенты'); expect(html).toContain('Состав изменён на сервере'); button('Отмена').onClick(); expect(h.close).toHaveBeenCalledOnce(); expect(h.save).not.toHaveBeenCalled();
    });
    it('unavailable saved agents remain removable with honest default reasons; fresh server names override saved labels', async () => {
        props.participants = [participant({name: 'Старое имя'}), participant({agentId: 'disabled', name: 'Отключённый', status: 'disabled'}), participant({agentId: 'removed', name: 'Удалённый', status: 'removed'}), participant({agentId: 'blocked', name: 'Блокирован', status: 'blocked'})];
        vi.mocked(modelChatApi.agents).mockResolvedValueOnce([participant({name: 'Новое имя', modelName: undefined})]); roster(); await flushSetup(); const html = roster(); expect(html).toContain('Новое имя'); expect(html).not.toContain('Старое имя'); expect(html).toContain('Модель текущего диалога'); expect(html).toContain('Отключён в проекте'); expect(html).toContain('Удалён из проекта'); expect(html).toContain('Недоступен');
        expect(uiNode(h.ui, 'Modal').okButtonProps.disabled).toBe(true); for (const label of ['Отключённый', 'Удалённый', 'Блокирован']) { checkbox(label).onChange({target: {checked: false}}); roster(); }
        expect(uiNode(h.ui, 'Modal').okButtonProps.disabled).toBe(false); expect(checkbox('Удалённый').disabled).toBe(true);
    });
    it('eight selections block only adding a ninth, and removing one enables a deliberate replacement', async () => {
        const all = Array.from({length: 9}, (_, i) => participant({agentId: `agent-${i}`, name: `Агент ${i}`})); props.participants = all.slice(0, 8); vi.mocked(modelChatApi.agents).mockResolvedValueOnce(all); roster(); await flushSetup(); roster();
        expect(checkbox('Агент 8').disabled).toBe(true); checkbox('Агент 0').onChange({target: {checked: false}}); roster(); expect(checkbox('Агент 8').disabled).toBe(false); checkbox('Агент 8').onChange({target: {checked: true}}); roster(); uiNode(h.ui, 'Modal').onOk(); await flushSetup(); expect(h.save).toHaveBeenCalledWith(all.slice(1).map(item => item.agentId));
    });
    it('a failed save retains its selection; owner loss during successful save prevents closing a foreign editor', async () => {
        props.inline = true; props.participants = [participant()]; h.save.mockResolvedValueOnce(false); roster(); await flushSetup(); roster(); button('Сохранить участников').onClick(); await flushSetup(); expect(h.close).not.toHaveBeenCalled(); roster(); expect(checkbox('Разработчик').checked).toBe(true);
        const pending = deferredSetup<boolean>(); h.save.mockReturnValueOnce(pending.promise); button('Сохранить участников').onClick(); h.owner.value = 'bob'; pending.resolve(true); await flushSetup(); expect(h.close).not.toHaveBeenCalled();
    });
    it('saving disables close/checkboxes, and group_chat off independently refuses the submit handler', async () => {
        props.participants = [participant()]; props.saving = true; roster(); await flushSetup(); roster(); expect(uiNode(h.ui, 'Modal')).toMatchObject({onCancel: undefined, closable: false, keyboard: false, maskClosable: false}); expect(checkbox('Разработчик').disabled).toBe(true);
        props.saving = false; h.enabled = false; roster(); expect(uiNode(h.ui, 'Modal').okButtonProps.disabled).toBe(true); uiNode(h.ui, 'Modal').onOk(); await flushSetup(); expect(h.save).not.toHaveBeenCalled();
    });
    it.each(['resolve', 'reject'] as const)('project/model switch aborts an old roster %s without exposing its data or error', async outcome => {
        const old = deferredSetup<IModelChatParticipant[]>(), next = deferredSetup<IModelChatParticipant[]>(); vi.mocked(modelChatApi.agents).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise); roster(); const oldSignal = vi.mocked(modelChatApi.agents).mock.calls[0][2]; props = {...props, modelId: 'model-two', projectId: 'project-two'}; roster(); expect(oldSignal.aborted).toBe(true);
        if (outcome === 'resolve') old.resolve([participant({name: 'PRIVATE OLD ROSTER'})]); else old.reject(Error('PRIVATE OLD ERROR')); await flushSetup(); expect(roster()).not.toContain('PRIVATE OLD'); expect(h.ui.nodes.some(node => node.kind === 'Spin')).toBe(true);
        next.resolve([participant({name: 'Новый состав'})]); await flushSetup(); expect(roster()).toContain('Новый состав');
    });
    it.each(['resolve', 'reject'] as const)('owner loss ignores late %s; unmount also aborts the transport', async outcome => {
        const pending = deferredSetup<IModelChatParticipant[]>(); vi.mocked(modelChatApi.agents).mockReturnValueOnce(pending.promise); roster(); const signal = vi.mocked(modelChatApi.agents).mock.calls[0][2]; h.owner.value = 'bob';
        if (outcome === 'resolve') pending.resolve([participant({name: 'PRIVATE USER'})]); else pending.reject(Error('PRIVATE ERROR')); await flushSetup(); expect(roster()).not.toContain('PRIVATE'); h.hooks.dispose(); expect(signal.aborted).toBe(true);
    });
});

describe('Research controls with the real selection hook: explicit consent and metadata-only setup', () => {
    it('opt-in reads only metadata; source callbacks create an exact per-message pin without inference or tool calls', async () => {
        controls(); expect(modelChatApi.researchChoices).not.toHaveBeenCalled(); checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); await flushSetup(); controls();
        expect(modelChatApi.researchChoices).toHaveBeenCalledExactlyOnceWith('model-one', 'project-one', expect.any(AbortSignal), 'chat-one'); expect(research.request).toEqual({project: true});
        checkbox('База знаний проекта').onChange({target: {checked: false}}); expect(controls()).toContain('Выберите хотя бы один источник'); expect(research.request).toBeUndefined();
        const select = uiNode(h.ui, 'Select'); expect(select.options.find((option: {value: string}) => option.value === 'old')).toMatchObject({disabled: true, title: 'Снят с проекта'}); select.onChange('exa'); controls();
        expect(research.request).toEqual({project: false, external: {assetId: 'exa', version: 3, manifest: 'a'.repeat(64)}}); uiNode(h.ui, 'Select').onChange(undefined); controls(); expect(research.request).toBeUndefined(); expect(modelChatApi.send).not.toHaveBeenCalled(); expect(modelChatApi.researchStep).not.toHaveBeenCalled();
    });
    it('explicit reload discards stale choices, shows loading/default limits, and reports unavailable sources honestly', async () => {
        controls(); checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); await flushSetup(); controls();
        const pending = deferredSetup<IChatResearchChoices>(); vi.mocked(modelChatApi.researchChoices).mockReturnValueOnce(pending.promise); button('Проверить источники').onClick(); controls(); const html = controls();
        expect(h.ui.nodes.some(node => node.kind === 'Spin')).toBe(true); expect(button('Проверить источники').disabled).toBe(true); expect(html).toContain('До 6 шагов'); expect(html).toContain('до 16 внешних'); expect(research.request).toBeUndefined();
        pending.resolve(choices({project: {available: false, reason: 'Индекс не готов'}, external: []})); await flushSetup(); expect(controls()).toContain('Индекс не готов'); expect(controls()).toContain('Назначьте проекту совместимый');
        expect(checkbox('База знаний проекта').disabled).toBe(false); checkbox('База знаний проекта').onChange({target: {checked: false}}); controls(); expect(checkbox('База знаний проекта').disabled).toBe(true); expect(uiNode(h.ui, 'Select').disabled).toBe(true);
    });
    it('metadata failure is visible and retryable without falsely advertising an empty external catalog', async () => {
        vi.mocked(modelChatApi.researchChoices).mockRejectedValueOnce(Error('Права на источник отозваны')); controls(); checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); await flushSetup(); const html = controls();
        expect(html).toContain('Права на источник отозваны'); expect(html).not.toContain('Назначьте проекту совместимый'); expect(research.request).toBeUndefined(); button('Проверить источники').onClick(); controls(); await flushSetup(); controls(); expect(research.request).toEqual({project: true});
    });
    it('an administrator disabling research blocks opt-in but still permits revoking prior consent and aborting metadata', async () => {
        const pending = deferredSetup<IChatResearchChoices>(); vi.mocked(modelChatApi.researchChoices).mockReturnValueOnce(pending.promise); controls(); checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); const signal = vi.mocked(modelChatApi.researchChoices).mock.calls[0][2]; h.enabled = false; controls();
        expect(checkbox('Исследовать источники').disabled).toBe(false); checkbox('Исследовать источники').onChange({target: {checked: false}}); controls(); expect(signal.aborted).toBe(true); expect(research.request).toBeUndefined(); expect(checkbox('Исследовать источники').disabled).toBe(true);
        checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); expect(research.enabled).toBe(false); pending.resolve(choices()); await flushSetup(); controls(); expect(research.choices).toBeUndefined();
    });
    it('a missing project or busy composer prevents new consent; busy state also freezes all source controls', async () => {
        projectId = undefined; controls(); expect(controls()).toContain('Доступно в чате проекта'); checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); expect(research.enabled).toBe(false);
        projectId = 'project-one'; disabled = true; controls(); checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); expect(research.enabled).toBe(false); expect(modelChatApi.researchChoices).not.toHaveBeenCalled();
        disabled = false; controls(); checkbox('Исследовать источники').onChange({target: {checked: true}}); controls(); await flushSetup(); disabled = true; controls(); expect(checkbox('База знаний проекта').disabled).toBe(true); expect(uiNode(h.ui, 'Select').disabled).toBe(true); expect(button('Проверить источники').disabled).toBe(true);
    });
});
