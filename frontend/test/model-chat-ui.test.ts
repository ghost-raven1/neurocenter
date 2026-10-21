import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelChatModal} from '../src/features/ModelChat/ModelChatModal';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';
import type {IModelChatTurn} from '../src/features/ModelChat/types';

interface IKeyboardEvent {
    key: string; shiftKey: boolean; keyCode: number; nativeEvent: {isComposing: boolean}; preventDefault: () => void;
}
interface ITextAreaProps {
    value: string; disabled?: boolean; onChange: (event: {target: {value: string}}) => void;
    onKeyDown: (event: IKeyboardEvent) => void; onCompositionStart: () => void; onCompositionEnd: () => void;
}
interface IButtonProps {children?: ReactNode; disabled?: boolean; onClick?: () => void;}
interface IConfirmProps {title?: string; content?: string; onOk: () => void; onCancel: () => void;}
const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    return {
        begin: () => {cursor = 0;}, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => {slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0;},
        state<T>(initial: T) {const slot = slots[cursor++] ??= {value: initial}; return [slot.value, (value: T) => {slot.value = value;}];},
        ref<T>(initial: T) {return (slots[cursor++] ??= {value: {current: initial}}).value;},
        effect(effect: () => void | (() => void), deps: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
            const slot = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});
        },
    };
});
const ui = vi.hoisted(() => ({
    owner: 'main-a', active: true, buttons: new Map<string, IButtonProps>(), input: undefined as ITextAreaProps | undefined,
    modalClose: undefined as (() => void) | undefined, confirm: undefined as IConfirmProps | undefined,
    destroyConfirm: vi.fn(), confirmCalls: vi.fn(), close: vi.fn(),
    chat: {turns: [] as IModelChatTurn[], error: '', blocked: '', busy: false, send: vi.fn(), retry: vi.fn(), stop: vi.fn(), reset: vi.fn(), editFailed: vi.fn(),
        captureOwner: () => {const owner = ui.owner; return () => ui.active && owner === ui.owner;}},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect}));
vi.mock('../src/features/ModelChat/useModelChat', () => ({useModelChat: () => ui.chat}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner: () => {const owner = ui.owner; return () => ui.active && owner === ui.owner;}})}));
vi.mock('@ant-design/icons', () => ({MessageOutlined: () => null, ReloadOutlined: () => null, SendOutlined: () => null, StopOutlined: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    const Modal = Object.assign(({children, onCancel}: {children?: ReactNode; onCancel: () => void}) => {ui.modalClose = onCancel; return createElement('dialog', null, children);}, {
        confirm: (props: IConfirmProps) => {ui.confirmCalls(); ui.confirm = props; return {destroy: ui.destroyConfirm};},
    });
    return {Modal, Space: content, Spin: () => null,
        Empty: ({description}: {description?: string}) => createElement('p', null, description),
        Alert: ({message}: {message?: string}) => createElement('p', {role: 'alert'}, message),
        Button: (props: IButtonProps) => {if (typeof props.children === 'string') ui.buttons.set(props.children, props); return createElement('button', {disabled: props.disabled}, props.children);},
        Input: {TextArea: (props: ITextAreaProps) => {ui.input = props; return createElement('textarea', {value: props.value, disabled: props.disabled, readOnly: true});}},
        Typography: {Text: content, Paragraph: content},
    };
});
const model: ICatalogModel = {id: 'model-chat', name: 'Чат-модель', description: '', capability: 'chat', runtime: 'remote-openai', model: 'upstream-model', modelVersion: 'v1',
    manifestSha256: null, verificationSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: ''};
const turn = (patch: Partial<IModelChatTurn> = {}): IModelChatTurn => ({id: 1, prompt: 'Вопрос', status: 'done', answer: {content: 'Ответ', finishReason: 'stop'}, ...patch});
function render(): string {
    hooks.begin(); ui.buttons.clear(); const html = renderToStaticMarkup(createElement(ModelChatModal, {model, projectId: 'prj-one', projectName: 'Проект', onClose: ui.close}));
    hooks.commit(); return html;
}
const input = (value: string): void => {ui.input!.onChange({target: {value}}); render();};
const key = (patch: Partial<IKeyboardEvent> = {}): IKeyboardEvent => ({key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: {isComposing: false}, preventDefault: vi.fn(), ...patch});

beforeEach(() => {
    hooks.dispose(); vi.clearAllMocks(); ui.owner = 'main-a'; ui.active = true; ui.input = undefined; ui.confirm = undefined;
    ui.chat.turns = []; ui.chat.error = ''; ui.chat.blocked = ''; ui.chat.busy = false; ui.chat.send.mockReturnValue(true); ui.chat.editFailed.mockReturnValue(undefined);
});
afterEach(() => {ui.active = false; hooks.dispose();});

describe('Чат: клавиатура и доступные действия', () => {
    it('Enter отправляет текст и очищает поле только после принятого запроса', () => {
        render(); input('Первый вопрос'); const event = key(); ui.input!.onKeyDown(event); render();
        expect(event.preventDefault).toHaveBeenCalledOnce(); expect(ui.chat.send).toHaveBeenCalledExactlyOnceWith('Первый вопрос'); expect(ui.input!.value).toBe('');
        ui.chat.send.mockReturnValue(false); input('Не потерять черновик'); ui.input!.onKeyDown(key()); render(); expect(ui.input!.value).toBe('Не потерять черновик');
    });
    it('Shift+Enter сохраняет обычный перенос строки', () => {
        render(); input('Первая строка'); const event = key({shiftKey: true}); ui.input!.onKeyDown(event);
        expect(ui.chat.send).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
    });
    it('Enter не отправляет незавершённую IME-композицию ни одним из браузерных способов', () => {
        render(); input('日本語'); ui.input!.onCompositionStart(); ui.input!.onKeyDown(key()); ui.input!.onCompositionEnd();
        ui.input!.onKeyDown(key({nativeEvent: {isComposing: true}})); ui.input!.onKeyDown(key({keyCode: 229})); expect(ui.chat.send).not.toHaveBeenCalled();
        ui.input!.onKeyDown(key()); expect(ui.chat.send).toHaveBeenCalledExactlyOnceWith('日本語');
    });
    it('Во время ответа показывает остановку и блокирует повторный ввод', () => {
        ui.chat.busy = true; ui.chat.turns = [turn({status: 'pending', answer: undefined})]; const html = render();
        expect(ui.input!.disabled).toBe(true); expect(ui.buttons.has('Отправить')).toBe(false); expect(html).toContain('Модель готовит ответ');
        ui.buttons.get('Остановить')!.onClick!(); expect(ui.chat.stop).toHaveBeenCalledOnce();
    });
    it('Ошибка сохраняет запрос, даёт повторить или вернуть его в редактор', () => {
        ui.chat.turns = [turn({status: 'failed', answer: undefined, error: 'Провайдер недоступен'})]; ui.chat.editFailed.mockReturnValue('Исправляемый вопрос'); render();
        expect(ui.input!.disabled).toBe(true); ui.buttons.get('Повторить запрос')!.onClick!(); expect(ui.chat.retry).toHaveBeenCalledOnce();
        ui.buttons.get('Изменить сообщение')!.onClick!(); render(); expect(ui.input!.value).toBe('Исправляемый вопрос');
    });
    it('Не скрывает достижение контекстного лимита и обрезанный ответ', () => {
        ui.chat.turns = Array.from({length: 20}, (_, index) => turn({id: index})); let html = render(); expect(ui.input!.disabled).toBe(true); expect(html).toContain('40 сообщений');
        ui.chat.turns = [turn({answer: {content: 'Часть ответа', finishReason: 'length'}})]; html = render(); expect(html).toContain('Ответ достиг лимита токенов');
    });
});

describe('Чат: данные модели и подтверждения', () => {
    it('Markdown не запускает HTML и не создаёт сетевые изображения, безопасные ссылки открываются отдельно', () => {
        ui.chat.turns = [turn({prompt: '<img src="https://track.invalid/prompt">', answer: {finishReason: 'stop', content:
            '<script>alert(1)</script>\n\n<img src="https://track.invalid/raw">\n\n![tracking](https://track.invalid/pixel)\n\n[unsafe](javascript:alert(1))\n\n[private](https://user:secret@host.invalid/)\n\n[safe](https://docs.example.test/guide)\n\n| A | B |\n| - | - |\n| 1 | 2 |'}})];
        const html = render(); expect(html).not.toContain('<script'); expect(html).not.toContain('<img'); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('href="https://user:secret');
        expect(html).toContain('Изображение: tracking'); expect(html).toContain('&lt;img src='); expect(html).toContain('href="https://docs.example.test/guide" target="_blank" rel="noopener noreferrer"');
        expect(html).toContain('class="model-chat__table" tabindex="0"');
    });
    it('Повторное закрытие не создаёт несколько подтверждений, отмена сохраняет чат', () => {
        ui.chat.turns = [turn()]; render(); ui.modalClose!(); ui.modalClose!(); expect(ui.confirmCalls).toHaveBeenCalledOnce();
        ui.confirm!.onCancel(); expect(ui.close).not.toHaveBeenCalled(); expect(ui.chat.stop).not.toHaveBeenCalled();
        ui.modalClose!(); expect(ui.confirmCalls).toHaveBeenCalledTimes(2); ui.confirm!.onOk(); expect(ui.chat.stop).toHaveBeenCalledOnce(); expect(ui.close).toHaveBeenCalledOnce();
    });
    it('Первый неотправленный черновик защищён подтверждением, пустой чат закрывается сразу', () => {
        render(); ui.modalClose!(); expect(ui.close).toHaveBeenCalledOnce(); expect(ui.confirmCalls).not.toHaveBeenCalled();
        ui.close.mockClear(); input('Первый неотправленный вопрос'); ui.modalClose!(); expect(ui.confirmCalls).toHaveBeenCalledOnce(); expect(ui.close).not.toHaveBeenCalled();
        ui.confirm!.onCancel(); render(); expect(ui.input!.value).toBe('Первый неотправленный вопрос'); expect(ui.close).not.toHaveBeenCalled();
    });
    it('Новый диалог очищает историю только после подтверждения', () => {
        ui.chat.turns = [turn()]; render(); input('Несохранённый черновик'); ui.buttons.get('Новый диалог')!.onClick!(); expect(ui.chat.reset).not.toHaveBeenCalled();
        ui.confirm!.onOk(); render(); expect(ui.chat.reset).toHaveBeenCalledOnce(); expect(ui.input!.value).toBe('');
    });
    it('Unmount уничтожает собственное подтверждение и не затрагивает чужие диалоги', () => {
        ui.chat.turns = [turn()]; render(); ui.modalClose!(); const previous = ui.confirm!;
        ui.active = false; hooks.dispose(); expect(ui.destroyConfirm).toHaveBeenCalledOnce();
        previous.onOk(); expect(ui.chat.stop).not.toHaveBeenCalled(); expect(ui.close).not.toHaveBeenCalled();
    });
    it('Позднее подтверждение прежнего пользователя не закрывает и не очищает новый чат', () => {
        ui.chat.turns = [turn()]; render(); ui.modalClose!(); const previous = ui.confirm!; ui.owner = 'developer-b';
        previous.onOk(); expect(ui.chat.stop).not.toHaveBeenCalled(); expect(ui.close).not.toHaveBeenCalled(); expect(ui.chat.reset).not.toHaveBeenCalled();
    });
});
