import './feature-flags-enabled';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ChatParticipantsEditor} from '../src/features/ModelChat/ChatParticipantsEditor';
import {modelChatApi} from '../src/features/ModelChat/api';
import {participant} from './model-chat-fixtures';
import type {IModelChatParticipant} from '../src/features/ModelChat/types';

const hooks = vi.hoisted(() => {
    let cursor = 0; const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    return {begin: () => {cursor = 0;}, commit: () => effects.splice(0).forEach(effect => effect()), dispose: () => {slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0;},
        state<T>(initial: T) {const slot = slots[cursor++] ??= {value: initial}; return [slot.value, (value: T) => {slot.value = value;}];},
        effect(effect: () => void | (() => void), deps: unknown[]) {const index = cursor++, previous = slots[index]; if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return; const slot = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});},
    };
});
interface Check {checked: boolean; disabled: boolean; onChange: (event: {target: {checked: boolean}}) => void; children: ReactNode;}
const ui = vi.hoisted(() => ({owner: 'alice', checks: new Map<string, Check>(), onOk: undefined as (() => void) | undefined, disabled: true, save: vi.fn(), close: vi.fn(),
    capture: () => {const owner = ui.owner; return () => owner === ui.owner;}}));
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: hooks.state, useEffect: hooks.effect}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {agents: vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner: ui.capture})}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Modal: ({children, onOk, okButtonProps}: {children: ReactNode; onOk: () => void; okButtonProps: {disabled: boolean}}) => {ui.onOk = onOk; ui.disabled = okButtonProps.disabled; return createElement('dialog', null, children);},
        Typography: {Text: content, Paragraph: content}, Spin: () => createElement('span', null, 'Загрузка'), Button: content,
        Alert: ({message}: {message: string}) => createElement('p', null, message), Checkbox: (props: Check) => {const name = (props.children as ReactNode[])[0] as string; ui.checks.set(name, props); return createElement('label', null, props.children);}};
});
const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
let participants: IModelChatParticipant[] | undefined;
function render(saving = false): string {hooks.begin(); ui.checks.clear(); const html = renderToStaticMarkup(createElement(ChatParticipantsEditor, {modelId: 'model', projectId: 'project', participants, saving, onSave: ui.save, onClose: ui.close})); hooks.commit(); return html;}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
beforeEach(() => {hooks.dispose(); vi.clearAllMocks(); participants = undefined; ui.owner = 'alice'; ui.save.mockResolvedValue(true); vi.mocked(modelChatApi.agents).mockResolvedValue([participant(), participant({agentId: 'review', name: 'Ревьюер', slug: 'nc-reviewer'})]);});
afterEach(() => hooks.dispose());

describe('Выбор существующих агентов проекта', () => {
    it('Не создаёт пустую группу; сохраняет выбранные ID и закрывается после ответа', async () => {
        render(); expect(ui.disabled).toBe(true); await flush(); render(); expect(ui.disabled).toBe(true);
        ui.checks.get('Разработчик')!.onChange({target: {checked: true}}); render(); expect(ui.disabled).toBe(false); ui.onOk!(); await flush(); expect(ui.save).toHaveBeenCalledExactlyOnceWith(['agent-dev']); expect(ui.close).toHaveBeenCalledOnce();
    });
    it('Недоступного нового участника нельзя выбрать; сохранённого удалённого можно убрать', async () => {
        participants = [participant({status: 'removed', reason: 'Удалён из проекта'})]; vi.mocked(modelChatApi.agents).mockResolvedValue([participant({agentId: 'disabled', name: 'Отключённый', status: 'disabled', reason: 'Отключён в проекте'})]);
        render(); await flush(); const html = render(); expect(html).toContain('Удалён из проекта'); expect(html).toContain('Отключён в проекте'); expect(ui.disabled).toBe(true); expect(ui.checks.get('Разработчик')!.disabled).toBe(false); expect(ui.checks.get('Отключённый')!.disabled).toBe(true);
        ui.checks.get('Разработчик')!.onChange({target: {checked: false}}); render(); expect(ui.checks.get('Разработчик')!.disabled).toBe(true); expect(ui.disabled).toBe(false); ui.onOk!(); await flush(); expect(ui.save).toHaveBeenCalledWith([]);
    });
    it('Восемь выбранных ограничивают добавление, снятие выбора остаётся доступным', async () => {
        const roster = Array.from({length: 9}, (_, i) => participant({agentId: `agent-${i}`, name: `Агент ${i}`, slug: `nc-agent-${i}`})); participants = roster.slice(0, 8); vi.mocked(modelChatApi.agents).mockResolvedValue(roster);
        render(); await flush(); render(); expect(ui.checks.get('Агент 8')!.disabled).toBe(true); expect(ui.checks.get('Агент 0')!.disabled).toBe(false); ui.checks.get('Агент 0')!.onChange({target: {checked: false}}); render(); expect(ui.checks.get('Агент 8')!.disabled).toBe(false);
    });
    it('Отказ сохранения не закрывает форму и не очищает выбор', async () => {
        participants = [participant()]; ui.save.mockResolvedValue(false); render(); await flush(); render(); ui.onOk!(); await flush(); render(); expect(ui.close).not.toHaveBeenCalled(); expect(ui.checks.get('Разработчик')!.checked).toBe(true);
    });
    it('Потеря владельца не принимает поздний roster и не закрывает чужую форму', async () => {
        const pending = deferred<IModelChatParticipant[]>(); vi.mocked(modelChatApi.agents).mockReturnValueOnce(pending.promise); render(); ui.owner = 'bob'; pending.resolve([participant({name: 'Чужой приватный агент'})]); await flush(); expect(render()).not.toContain('Чужой приватный агент');
    });
    it('Ошибка загрузки блокирует сохранение и показывает точную причину', async () => {
        vi.mocked(modelChatApi.agents).mockRejectedValueOnce(new Error('Нет доступа к проекту')); render(); await flush(); expect(render()).toContain('Нет доступа к проекту'); expect(ui.disabled).toBe(true);
    });
});
