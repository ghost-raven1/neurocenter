import './feature-flags-enabled';
import {createElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ChatComposer} from '../src/features/ModelChat/ChatComposer';
import {ChatContextMeter} from '../src/features/ModelChat/ChatContextMeter';
import {ChatMessages} from '../src/features/ModelChat/ChatMessages';
import {ChatAttachments} from '../src/features/ModelChat/ChatAttachments';
import {ConversationList} from '../src/features/ModelChat/ConversationList';
import {ModelChatModal} from '../src/features/ModelChat/ModelChatModal';
import {ChatWorkspace} from '../src/features/ModelChat/ChatWorkspace';
import {ChatProjectContext} from '../src/features/ModelChat/ChatProjectContext';
import {detail, evidence, model, participant, response, turn} from './model-chat-fixtures';
import type {IModelChatTurn} from '../src/features/ModelChat/types';

interface Keyboard {key: string; shiftKey: boolean; keyCode: number; nativeEvent: {isComposing: boolean}; defaultPrevented?: boolean; preventDefault: () => void;}
interface TextArea {value: string; onChange: (event: {target: {value: string}}) => void; disabled?: boolean; onKeyDown: (event: Keyboard) => void; onPaste: (event: {clipboardData: {files: File[]}}) => void; onCompositionStart: () => void; onCompositionEnd: () => void;}
interface ButtonProps {children?: ReactNode; disabled?: boolean; onClick?: () => void; 'aria-label'?: string;}
interface Confirmation {onOk: () => void; onCancel: () => void;}
type GroupEditorProps = Parameters<typeof import('../src/features/ModelChat/ChatParticipantsEditor').ChatParticipantsEditor>[0];
const hooks = vi.hoisted(() => {
    let cursor = 0, viewport: unknown;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    return {
        begin: () => {cursor = 0;}, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => {slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; viewport = undefined;},
        viewport: (value: unknown) => {viewport = value;},
        state<T>(initial: T) {const slot = slots[cursor++] ??= {value: initial}; return [slot.value, (value: T) => {slot.value = value;}];},
        ref<T>(initial: T) {const ref = (slots[cursor++] ??= {value: {current: initial}}).value as {current: T}; if (initial === null && viewport !== undefined) ref.current = viewport as T; return ref;},
        effect(effect: () => void | (() => void), deps: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
            const slot = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});
        },
    };
});
const ui = vi.hoisted(() => ({
    input: undefined as TextArea | undefined, buttons: new Map<string, ButtonProps>(), modalClose: undefined as (() => void) | undefined,
    mention: undefined as {onPressEnter: (event: Keyboard) => void; onChange: (value: string) => void; options: Array<{value: string; label: string}>} | undefined,
    groupEditor: undefined as GroupEditorProps | undefined,
    context: undefined as ReturnType<typeof detail>['context'] | undefined,
    selectConversation: undefined as ((id: string) => void) | undefined, confirm: undefined as Confirmation | undefined, confirmCalls: vi.fn(), owner: 'alice', close: vi.fn(),
    chat: {items: [] as ReturnType<typeof detail>['conversation'][], detail: null as ReturnType<typeof detail> | null, turns: [] as IModelChatTurn[], uploads: [], attachments: [], activity: '', error: '', blocked: '', busy: false,
        send: vi.fn(), retry: vi.fn(), stop: vi.fn(), stopOwn: vi.fn(), select: vi.fn(), refresh: vi.fn(), newChat: vi.fn(), rename: vi.fn(), remove: vi.fn(), editFailed: vi.fn(), addFiles: vi.fn(), cancelUploads: vi.fn(), removeUpload: vi.fn(), retryUpload: vi.fn(), removeAttachment: vi.fn(), historyLoading: false, historyError: '', loadEarlier: vi.fn(), configureParticipants: vi.fn(), complete: vi.fn(),
        captureOwner: () => {const owner = ui.owner; return () => owner === ui.owner;}},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect, useLayoutEffect: hooks.effect}));
vi.mock('../src/features/ModelChat/ConversationList', async original => {
    const actual = await original<typeof import('../src/features/ModelChat/ConversationList')>();
    return {ConversationList: (props: Parameters<typeof actual.ConversationList>[0]) => {ui.selectConversation = props.onSelect; return actual.ConversationList(props);}};
});
vi.mock('../src/features/ModelChat/useModelChat', () => ({useModelChat: () => ui.chat}));
vi.mock('../src/features/ModelChat/useChatContext', () => ({useChatContext: () => ({context: ui.context ?? detail().context, loading: false, error: '', rejected: false})}));
vi.mock('../src/common/components/FileDropZone/FileDropZone', () => ({FileDropZone: ({hint}: {hint: string}) => createElement('p', null, hint)}));
vi.mock('../src/features/ModelChat/ChatResearchControls', () => ({ChatResearchControls: () => null}));
vi.mock('../src/features/ModelChat/AttachmentPreview', () => ({AttachmentPreview: () => null}));
vi.mock('../src/features/ModelChat/ChatParticipantsEditor', () => ({ChatParticipantsEditor: (props: GroupEditorProps) => {ui.groupEditor = props; return null;}}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    const Input = Object.assign((props: {value?: string; 'aria-label'?: string}) => createElement('input', {'aria-label': props['aria-label'], value: props.value, readOnly: true}), {
        TextArea: (props: TextArea) => {ui.input = props; return createElement('textarea', {value: props.value, disabled: props.disabled, readOnly: true});}, Search: () => createElement('input', {'aria-label': 'Поиск диалогов'}),
    });
    const Modal = Object.assign(({children, onCancel, open, title}: {children?: ReactNode; onCancel: () => void; open?: boolean; title?: ReactNode}) => {if (!open) return null; ui.modalClose = onCancel; return createElement('dialog', null, title, children);}, {confirm: (props: Confirmation) => {ui.confirmCalls(); ui.confirm = props; return {destroy: vi.fn()};}});
    const Empty = Object.assign(({description}: {description?: string}) => createElement('p', null, description), {PRESENTED_IMAGE_SIMPLE: null});
    return {Modal, Input, Mentions: (props: typeof ui.mention & {value: string; disabled?: boolean}) => {ui.mention = props!; return createElement('textarea', {value: props!.value, disabled: props!.disabled, readOnly: true});}, Empty, Space: content, Spin: () => createElement('span', null, 'Загрузка'), Tooltip: content,
        Typography: {Text: content, Paragraph: content}, Alert: ({message}: {message?: string}) => createElement('p', {role: 'alert'}, message),
        Button: (props: ButtonProps) => {const key = props['aria-label'] ?? (typeof props.children === 'string' ? props.children : ''); if (key) ui.buttons.set(key, props); return createElement('button', {disabled: props.disabled, 'aria-label': props['aria-label']}, props.children);},
        Progress: ({percent}: {percent: number}) => createElement('div', {role: 'progressbar', 'aria-valuenow': percent}),
    };
});
const render = (node: ReactNode): string => {hooks.begin(); ui.buttons.clear(); const html = renderToStaticMarkup(node); hooks.commit(); return html;};
const key = (patch: Partial<Keyboard> = {}): Keyboard => ({key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: {isComposing: false}, preventDefault: vi.fn(), ...patch});
const composer = (patch: Partial<Parameters<typeof ChatComposer>[0]> = {}) => ({draft: 'Вопрос', disabled: false, canSend: true, sending: false, uploading: false, onDraft: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onCancelUpload: vi.fn(), onFiles: vi.fn(), onReject: vi.fn(), ...patch});
beforeEach(() => {hooks.dispose(); vi.clearAllMocks(); ui.input = undefined; ui.mention = undefined; ui.groupEditor = undefined; ui.confirm = undefined; ui.context = undefined; ui.owner = 'alice'; ui.chat.detail = null; ui.chat.items = []; ui.chat.turns = []; ui.chat.activity = ''; ui.chat.busy = false; ui.chat.error = ''; ui.chat.blocked = ''; ui.chat.newChat.mockResolvedValue(true); ui.chat.select.mockResolvedValue(true); ui.chat.remove.mockResolvedValue(true); ui.chat.configureParticipants.mockResolvedValue(true);});
afterEach(() => {hooks.dispose(); vi.unstubAllGlobals();});

describe('Редактор: клавиатура, вставка файлов и отмена', () => {
    it('Смена модели/проекта из общего overlay подтверждает потерю draft; отмена сохраняет его', () => {
        const changed=vi.fn();let navigate!:(action:()=>void)=>void;
        const navigation={items:[],loading:false,onSelect:vi.fn(),onRefresh:vi.fn(),onChanged:vi.fn(),controls:(request:(action:()=>void)=>void)=>{navigate=request;return null;}};
        const panel=()=>render(createElement(ChatWorkspace,{model,projectId:'prj-one',onClose:ui.close,navigation}));
        panel();ui.input!.onChange({target:{value:'Сохрани этот черновик'}});panel();navigate(changed);expect(changed).not.toHaveBeenCalled();expect(ui.confirm).toBeDefined();ui.confirm!.onCancel();panel();expect(ui.input!.value).toBe('Сохрани этот черновик');expect(changed).not.toHaveBeenCalled();
        navigate(changed);ui.confirm!.onOk();expect(changed).toHaveBeenCalledOnce();
    });
    it('Общий overlay открывает другую модель через общий индекс и настраивает участников inline', () => {
        const open=vi.fn(),other={...detail().conversation,id:'other',modelId:'another-model'};
        const navigation={items:[other],loading:false,initialGroup:true,onSelect:open,onRefresh:vi.fn(),onChanged:vi.fn(),controls:()=>null};
        render(createElement(ChatWorkspace,{model,projectId:'prj-one',onClose:ui.close,navigation}));expect(ui.groupEditor?.inline).toBe(true);ui.selectConversation!('other');expect(open).toHaveBeenCalledWith(other);expect(ui.chat.select).not.toHaveBeenCalled();
    });
    it('После подтверждения перехода к другой модели синхронно останавливает own request до prefetch, новый input заблокирован',()=>{
        ui.chat.activity='sending';ui.chat.busy=true;const open=vi.fn(),other={...detail().conversation,id:'other',modelId:'another-model'};
        const navigation={items:[other],loading:false,opening:false,onSelect:open,onRefresh:vi.fn(),onChanged:vi.fn(),controls:()=>null};
        render(createElement(ChatWorkspace,{model,projectId:'prj-one',onClose:ui.close,navigation}));ui.selectConversation!('other');expect(open).not.toHaveBeenCalled();ui.confirm!.onOk();expect(ui.chat.stopOwn).toHaveBeenCalledOnce();expect(ui.chat.stopOwn.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
        ui.chat.activity='';ui.chat.busy=false;render(createElement(ChatWorkspace,{model,projectId:'prj-one',onClose:ui.close,navigation:{...navigation,opening:true}}));expect(ui.input!.disabled).toBe(true);expect(ui.buttons.get('Отправить')?.disabled).toBe(true);
    });
    it('Enter отправляет, Shift+Enter и IME-композиция сохраняют текст', () => {
        const props = composer(); render(createElement(ChatComposer, props)); const input = ui.input!;
        input.onKeyDown(key({shiftKey: true})); input.onCompositionStart(); input.onKeyDown(key()); input.onCompositionEnd(); input.onKeyDown(key({keyCode: 229})); input.onKeyDown(key({nativeEvent: {isComposing: true}})); expect(props.onSend).not.toHaveBeenCalled();
        const enter = key(); input.onKeyDown(enter); expect(enter.preventDefault).toHaveBeenCalledOnce(); expect(props.onSend).toHaveBeenCalledOnce();
    });
    it('Нельзя отправить через Enter при неготовых файлах/контексте', () => {
        const props = composer({canSend: false}); render(createElement(ChatComposer, props)); ui.input!.onKeyDown(key()); expect(props.onSend).not.toHaveBeenCalled(); expect(ui.buttons.get('Отправить')?.disabled).toBe(true);
    });
    it('Clipboard передаёт только файлы, обычная вставка текста не перехватывается', () => {
        const props = composer(); render(createElement(ChatComposer, props)); ui.input!.onPaste({clipboardData: {files: []}}); expect(props.onFiles).not.toHaveBeenCalled();
        const file = new File(['test'], 'doc.txt'); ui.input!.onPaste({clipboardData: {files: [file]}}); expect(props.onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    });
    it('Показывает отдельную отмену загрузки и остановку генерации', () => {
        const props = composer({uploading: true, disabled: true}); render(createElement(ChatComposer, props)); ui.buttons.get('Отменить загрузку')!.onClick!(); expect(props.onCancelUpload).toHaveBeenCalledOnce();
        const generation = composer({sending: true, disabled: true}); render(createElement(ChatComposer, generation)); ui.buttons.get('Остановить')!.onClick!(); expect(generation.onStop).toHaveBeenCalledOnce();
    });
});

describe('Контекст: честная оценка и реальные данные API', () => {
    it('Настоящий preflight-отказ не маскирует как нехватку контекста и показывает причину один раз', () => {
        const html = render(createElement(ChatContextMeter, {loading: false, rejected: true, error: 'Документ уже удалён'})); expect(html).toContain('Сообщение требует проверки'); expect(html).not.toContain('не помещается в контекст'); expect(html.match(/Документ уже удалён/g)).toHaveLength(1);
    });
    it('В основном статусе нет технических лимитов; подробности закрыты по умолчанию', () => {
        const html = render(createElement(ChatContextMeter, {context: detail().context, loading: false}));
        const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
        expect(summary).toContain('Контекст готов'); expect(summary).toContain('Подробнее'); expect(summary).not.toContain('токен'); expect(summary).not.toContain('КиБ'); expect(html).toContain('<details>'); expect(html).not.toContain('<details open');
    });
    it('При неизвестном окне нет выдуманного процента и точного подсчёта', () => {
        const html = render(createElement(ChatContextMeter, {context: detail().context, loading: false})); expect(html).toContain('≈ 1 токенов'); expect(html).toContain('не сообщил размер окна модели'); expect(html).not.toContain('progressbar'); expect(html).not.toContain('по данным API');
    });
    it('Учитывает резерв ответа при известном окне и отделяет лимит передачи', () => {
        const context = {...detail().context, contextWindowTokens: 1000, estimatedInputTokens: 400, reservedOutputTokens: 100};
        const html = render(createElement(ChatContextMeter, {context, loading: false, usage: turn().answer!.usage})); expect(html).toContain('aria-valuenow="50"'); expect(html).toContain('Резерв ответа: 100'); expect(html).toContain('Технические сведения:'); expect(html).toContain('по данным API');
    });
    it('Не превращает отсутствующий usage в измеренный ноль', () => {
        const html = render(createElement(ChatContextMeter, {context: detail().context, loading: false, usage: {inputTokens: null, outputTokens: null, totalTokens: null, reported: false}})); expect(html).not.toContain('по данным API');
    });
    it('Сжатие показывает по фактической фазе и не обещает его без серверных данных', () => {
        let html = render(createElement(ChatContextMeter, {loading: false})); expect(html).not.toContain('Автосжатие включено'); expect(html).not.toContain('Сжимаем');
        html = render(createElement(ChatContextMeter, {context: {...detail().context, canCompact: true, compactionNeeded: true}, loading: false, compaction: {state: 'none', coveredTurns: 0}})); expect(html).toContain('при отправке'); expect(html).not.toContain('Сжимаем раннюю');
        html = render(createElement(ChatContextMeter, {context: detail().context, loading: false, phase: 'compacting', compaction: {state: 'compacting', coveredTurns: 0}})); expect(html).toContain('Сжимаем раннюю переписку');
        html = render(createElement(ChatContextMeter, {context: detail().context, loading: false, phase: 'compacting', failed: true, compaction: {state: 'none', coveredTurns: 0}})); expect(html).toContain('Не удалось сжать контекст'); expect(html).toContain('История сохранена');
    });
    it('Сжимаемая история не блокирует отправку; непомещающееся новое сообщение блокирует', () => {
        ui.chat.detail = detail(); ui.context = {...detail().context, exceeded: true, canCompact: true, compactionNeeded: true};
        const panel = () => render(createElement(ModelChatModal, {model, onClose: ui.close})); panel(); ui.input!.onChange({target: {value: 'Продолжай'}}); panel(); expect(ui.buttons.get('Отправить')?.disabled).toBe(false);
        ui.context = {...ui.context, canCompact: false}; panel(); expect(ui.buttons.get('Отправить')?.disabled).toBe(true); expect(ui.input!.disabled).toBe(false);
    });
});

describe('История и файлы', () => {
    it('Prepend сохраняет место чтения, новый ответ не утаскивает пользователя вниз', () => {
        const node = {scrollTop: 0, scrollHeight: 1000, clientHeight: 200}; hooks.viewport(node);
        const first = turn({id: 'first', requestId: 'request-first'}), last = turn({id: 'last', requestId: 'request-last'});
        const props = {attachments: [], modelName: 'Модель', busy: false, blocked: false, onRetry: vi.fn(), onEdit: vi.fn(), onPreview: vi.fn()};
        const component = (turns: IModelChatTurn[]) => {hooks.begin(); const result = ChatMessages({...props, turns}); hooks.commit(); return result;};
        const tree = component([first, last]); node.scrollTop = 200;
        const history = (tree.props.children as ReactElement[])[0] as ReactElement<{onScroll: (event: {currentTarget: typeof node}) => void}>;
        history.props.onScroll({currentTarget: node});
        const earlier = turn({id: 'earlier', requestId: 'request-earlier'}); node.scrollHeight = 1600; component([earlier, first, last]); expect(node.scrollTop).toBe(800);
        node.scrollHeight = 1800; const newest = turn({id: 'newest', requestId: 'request-newest'}); component([earlier, first, last, newest]); expect(node.scrollTop).toBe(800);
        const updated = component([earlier, first, last, newest]); const latest = (updated.props.children as ReactElement[])[1]; expect(latest.props.children).toBe('К последним сообщениям');
    });
    it('Ранние сообщения загружаются отдельной кнопкой, её ошибка не скрывает текущую историю', () => {
        const load = vi.fn(); const html = render(createElement(ChatMessages, {turns: [turn()], attachments: [], modelName: 'Модель', busy: true, blocked: false, onRetry: vi.fn(), onEdit: vi.fn(), onPreview: vi.fn(), hasEarlier: true, historyError: 'Не удалось загрузить страницу', onLoadEarlier: load}));
        ui.buttons.get('Показать ранние сообщения')!.onClick!(); expect(load).toHaveBeenCalledOnce(); expect(html).toContain('Не удалось загрузить страницу'); expect(html).toContain('Ответ');
    });
    it('Сжатие и его ошибка отличаются от обычной генерации ответа', () => {
        const props = {attachments: [], modelName: 'Модель', busy: false, blocked: false, onRetry: vi.fn(), onEdit: vi.fn(), onPreview: vi.fn()};
        let html = render(createElement(ChatMessages, {...props, turns: [turn({status: 'pending', answer: undefined, processingStage: 'compacting'})]})); expect(html).toContain('Сжимаем раннюю переписку');
        html = render(createElement(ChatMessages, {...props, turns: [turn({status: 'failed', answer: undefined, processingStage: 'compacting'})]})); expect(html).toContain('История сохранена'); expect(ui.buttons.has('Повторить запрос')).toBe(true);
    });
    it('Markdown остаётся инертным: HTML и сетевые картинки не исполняются', () => {
        const html = render(createElement(ChatMessages, {turns: [turn({prompt: '<img src="track">', answer: {finishReason: 'stop', content: '<script>alert(1)</script>\n\n<img src="https://track.invalid/raw">\n\n![tracking](https://track.invalid/pixel)\n\n[unsafe](javascript:alert(1))\n\n[safe](https://docs.example.test/guide)\n\n| A | B |\n| - | - |\n| 1 | 2 |'}})], attachments: [], modelName: 'Модель', busy: false, blocked: false, onRetry: vi.fn(), onEdit: vi.fn(), onPreview: vi.fn()}));
        expect(html).not.toContain('<script'); expect(html).not.toContain('<img'); expect(html).not.toContain('href="javascript:'); expect(html).toContain('&lt;img src='); expect(html).toContain('Изображение: tracking'); expect(html).toContain('target="_blank" rel="noopener noreferrer"'); expect(html).toContain('tabindex="0"');
    });
    it('Показывает вложение сохранённого сообщения и открывает его только явно', () => {
        const preview = vi.fn(), file = {id: 'file-1', name: 'report.txt', mediaType: 'text/plain', bytes: 12, textBytes: 12, createdAt: ''};
        render(createElement(ChatMessages, {turns: [turn({attachmentIds: [file.id]})], attachments: [file], modelName: 'Модель', busy: false, blocked: false, onRetry: vi.fn(), onEdit: vi.fn(), onPreview: preview}));
        expect(preview).not.toHaveBeenCalled(); ui.buttons.get('report.txt')!.onClick!(); expect(preview).toHaveBeenCalledWith(file.id);
    });
    it('Копирует ответ по кнопке и предлагает исправить только неуспешный хвост', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined), retry = vi.fn(), edit = vi.fn(); vi.stubGlobal('navigator', {clipboard: {writeText}});
        render(createElement(ChatMessages, {turns: [turn(), turn({id: 'failed', status: 'failed', answer: undefined, error: 'Провайдер недоступен'})], attachments: [], modelName: 'Модель', busy: false, blocked: false, onRetry: retry, onEdit: edit, onPreview: vi.fn()}));
        ui.buttons.get('Скопировать ответ')!.onClick!(); await Promise.resolve(); expect(writeText).toHaveBeenCalledWith('Ответ'); ui.buttons.get('Повторить запрос')!.onClick!(); ui.buttons.get('Изменить сообщение')!.onClick!(); expect(retry).toHaveBeenCalledOnce(); expect(edit).toHaveBeenCalledOnce();
    });
    it('Документ готов, ошибка загрузки и неподдерживаемое изображение имеют разные действия', () => {
        const file = {id: 'file-1', name: 'report.txt', mediaType: 'text/plain', bytes: 12, textBytes: 12, createdAt: ''};
        const html = render(createElement(ChatAttachments, {files: [file], uploads: [{id: 'bad', name: 'scan.png', bytes: 4, file: new File(['x'], 'scan.png'), state: 'failed', error: 'Нужен OCR'}], disabled: false, onPreview: vi.fn(), onRemove: vi.fn(), onRetryUpload: vi.fn(), onRemoveUpload: vi.fn()}));
        expect(html).toContain('текст извлечён'); expect(html).toContain('Нужен OCR'); expect(ui.buttons.get('Повторить загрузку scan.png')?.disabled).toBe(true); expect(ui.buttons.get('Убрать файл scan.png')?.disabled).toBe(false);
    });
    it('Список диалогов показывает текущий и объясняет личное владение', () => {
        const html = render(createElement(ConversationList, {items: [detail().conversation], selected: 'chat-1', disabled: false, loading: false, onSelect: vi.fn(), onNew: vi.fn(), onRefresh: vi.fn()}));
        expect(html).toContain('Первый диалог'); expect(html).toContain('aria-current="page"'); expect(html).toContain('доступны только вам'); expect(html).toContain('Поиск диалогов');
    });
});

describe('Сохранённый чат и подтверждения', () => {
    it.each(['new', 'select', 'delete'])('Не теряет неотправленный текст при ошибке %s', async action => {
        ui.chat.detail = detail(); ui.chat.items = [detail().conversation];
        const panel = () => render(createElement(ModelChatModal, {model, onClose: ui.close}));
        panel(); ui.input!.onChange({target: {value: 'Сохранить черновик'}}); panel();
        if (action === 'new') {ui.chat.newChat.mockResolvedValue(false); ui.buttons.get('Создать новый диалог')!.onClick!();}
        else if (action === 'select') {ui.chat.select.mockResolvedValue(false); ui.selectConversation!('chat-2');}
        else {ui.chat.remove.mockResolvedValue(false); ui.buttons.get('Удалить диалог')!.onClick!();}
        await ui.confirm!.onOk(); await Promise.resolve(); panel(); expect(ui.input!.value).toBe('Сохранить черновик');
    });
    it('Успешный переход очищает черновик после подтверждения и ответа сервера', async () => {
        ui.chat.detail = detail(); const panel = () => render(createElement(ModelChatModal, {model, onClose: ui.close}));
        panel(); ui.input!.onChange({target: {value: 'Черновик'}}); panel(); ui.buttons.get('Создать новый диалог')!.onClick!(); await ui.confirm!.onOk(); await Promise.resolve(); panel(); expect(ui.input!.value).toBe('');
    });

    it('Закрывает сохранённую историю без предупреждения о её потере', () => {
        ui.chat.detail = detail({turns: [turn()]}); ui.chat.turns = [turn()]; render(createElement(ModelChatModal, {model, onClose: ui.close})); ui.modalClose!();
        expect(ui.close).toHaveBeenCalledOnce(); expect(ui.confirmCalls).not.toHaveBeenCalled();
    });
    it('Закрытие не отменяет pending из другого окна, а свой HTTP останавливает синхронно', () => {
        ui.chat.busy = true; ui.chat.turns = [turn({status: 'pending', answer: undefined})];
        render(createElement(ModelChatModal, {model, onClose: ui.close})); ui.modalClose!(); expect(ui.confirmCalls).not.toHaveBeenCalled(); expect(ui.chat.stop).not.toHaveBeenCalled(); expect(ui.close).toHaveBeenCalledOnce();
        ui.close.mockClear(); ui.chat.activity = 'sending'; render(createElement(ModelChatModal, {model, onClose: ui.close})); ui.modalClose!(); ui.confirm!.onOk(); expect(ui.chat.stopOwn).toHaveBeenCalledTimes(2); expect(ui.close).toHaveBeenCalledOnce(); expect(ui.chat.stop).not.toHaveBeenCalled();
    });
    it('Запрос закрытия при генерации требует подтверждения; старый owner не может его выполнить', () => {
        ui.chat.busy = true; ui.chat.activity = 'sending'; ui.chat.turns = [turn({status: 'pending', answer: undefined})]; render(createElement(ModelChatModal, {model, onClose: ui.close}));
        ui.modalClose!(); ui.modalClose!(); expect(ui.confirmCalls).toHaveBeenCalledOnce(); expect(ui.close).not.toHaveBeenCalled(); ui.owner = 'bob'; ui.confirm!.onOk(); expect(ui.close).not.toHaveBeenCalled(); expect(ui.chat.stop).not.toHaveBeenCalled();
    });
});

describe('Групповые ответы и контекст проекта', () => {
    it('Оптимистичный pending группы не приписывает ответ базовой модели; прежняя model-история остаётся подписана', () => {
        const props = {attachments: [], modelName: 'Базовая модель', busy: true, blocked: false, onRetry: vi.fn(), onEdit: vi.fn(), onPreview: vi.fn(), group: true};
        let html = render(createElement(ChatMessages, {...props, turns: [turn({status: 'pending', answer: undefined})]})); expect(html).toContain('Участники группы готовят ответы'); expect(html).not.toContain('Базовая модель');
        html = render(createElement(ChatMessages, {...props, turns: [turn()]})); expect(html).toContain('Базовая модель'); expect(html).toContain('Ответ');
    });
    it('Подписывает отдельные ответы и сохраняет успешный ответ при частичном отказе', async () => {
        const complete = vi.fn(), retry = vi.fn(), writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', {clipboard: {writeText}});
        const html = render(createElement(ChatMessages, {turns: [turn({status: 'failed', answer: undefined, responses: [response(), response({id: 'failed-review', agentId: 'review', name: 'Ревьюер', status: 'failed', answer: undefined, error: 'Недоступен провайдер'})]})], attachments: [], modelName: model.name, busy: false, blocked: false, onRetry: retry, onEdit: vi.fn(), onPreview: vi.fn(), onComplete: complete}));
        expect(html).toContain('Ответ агента Разработчик'); expect(html).toContain('Ответ агента Ревьюер'); expect(html).toContain('Недоступен провайдер'); expect(ui.buttons.has('Изменить сообщение')).toBe(false);
        ui.buttons.get('Скопировать ответ · Разработчик')!.onClick!(); await Promise.resolve(); expect(writeText).toHaveBeenCalledWith('Ответ');
        ui.buttons.get('Повторить неуспешные ответы')!.onClick!(); ui.buttons.get('Продолжить с готовыми ответами')!.onClick!(); expect(retry).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
    });
    it('Группа с явным @ показывает адресата; неизвестный адрес не превращается в отправку всем', () => {
        const props = composer({participants: [participant()]}); let html = render(createElement(ChatComposer, props));
        expect(html).toContain('Получат все участники'); expect(ui.mention!.options).toEqual([{value: 'nc-developer', label: 'Разработчик · @nc-developer'}]);
        html = render(createElement(ChatComposer, {...props, draft: '@nc-developer вопрос'})); expect(html).toContain('Получат: Разработчик'); ui.mention!.onPressEnter(key()); expect(props.onSend).toHaveBeenCalledOnce();
        render(createElement(ChatComposer, {...props, draft: '@nc-typo вопрос'})); expect(ui.buttons.get('Отправить')!.disabled).toBe(true); ui.mention!.onPressEnter(key()); expect(props.onSend).toHaveBeenCalledOnce();
    });
    it('Enter, уже обработанный подсказкой @, не отправляет сообщение раньше выбора', () => {
        const props = composer({participants: [participant()], draft: '@nc-developer'}); render(createElement(ChatComposer, props)); ui.mention!.onPressEnter(key({defaultPrevented: true})); expect(props.onSend).not.toHaveBeenCalled();
        ui.mention!.onPressEnter(key()); expect(props.onSend).toHaveBeenCalledOnce();
    });
    it('Агентов можно добавить прямо к сохранённому проектному диалогу', async () => {
        ui.chat.detail = detail({turns: [turn()]}); ui.chat.turns = [turn()]; const panel = () => render(createElement(ModelChatModal, {model, projectId: 'prj-one', onClose: ui.close})); expect(panel()).toContain('Добавить агентов');
        ui.buttons.get('Добавить агентов')!.onClick!(); panel(); expect(ui.groupEditor?.joining).toBe(true); await ui.groupEditor!.onSave(['agent-dev']);
        expect(ui.chat.configureParticipants).toHaveBeenCalledWith(['agent-dev']); expect(ui.chat.newChat).not.toHaveBeenCalled(); expect(ui.chat.turns).toEqual([turn()]);
    });
    it('Показывает окна участников отдельно, неизвестному окну не придумывает процент', () => {
        const context = {...detail().context, participants: [{agentId: 'dev', name: 'Разработчик', modelId: 'small', modelName: 'Маленькая', context: {...detail().context, contextWindowTokens: 1000, reservedOutputTokens: 100, estimatedInputTokens: 400}}, {agentId: 'review', name: 'Ревьюер', modelId: 'unknown', modelName: 'Неизвестная', context: detail().context}]};
        const html = render(createElement(ChatContextMeter, {context, loading: false})); expect(html).toContain('Контекст участников'); expect(html).toContain('Разработчик · Маленькая'); expect(html).toContain('Ревьюер · Неизвестная'); expect(html.match(/role="progressbar"/g)).toHaveLength(1); expect(html).toContain('aria-valuenow="50"'); expect(html).not.toContain('<details open');
    });
    it('Сжимаемость одного участника не скрывает непомещающийся ввод другого', () => {
        const context = {...detail().context, exceeded: true, canCompact: true, participants: [{agentId: 'dev', name: 'Разработчик', modelId: 'small', modelName: 'Маленькая', context: {...detail().context, exceeded: true, canCompact: false}}, {agentId: 'review', name: 'Ревьюер', modelId: 'large', modelName: 'Большая', context: {...detail().context, exceeded: false, canCompact: true}}]};
        ui.context = context; ui.chat.detail = detail(); const panel = () => render(createElement(ModelChatModal, {model, onClose: ui.close})); panel(); ui.input!.onChange({target: {value: 'Проверка'}}); panel(); expect(ui.buttons.get('Отправить')?.disabled).toBe(true);
    });
    it('Источники привязаны к ответу, пути/выдержки инертны, технический score не перегружает UI', () => {
        const html = render(createElement(ChatProjectContext, {answer: true, evidence: evidence({sources: [{id: 'x', path: 'javascript:bad', title: 'Инструкция', score: 0.9234567, startLine: 4, endLine: 6, excerpt: '<img src="https://track.test">'}]})}));
        expect(html).toContain('Источники · 1'); expect(html).toContain('javascript:bad:4–6'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('href='); expect(html).not.toContain('0.9234567'); expect(html).not.toContain('<details open');
    });
    it.each(['metadata', 'empty', 'unavailable'] as const)('Не выдаёт %s за успешный RAG-поиск', status => {
        const html = render(createElement(ChatProjectContext, {answer: true, evidence: evidence({status, sources: [], message: 'Фактический статус сервера'})}));
        expect(html).toContain('Фактический статус сервера'); expect(html).not.toContain('Контекст проекта подключён'); expect(html).not.toContain('Источники ·');
    });
    it('Состав группы явно показывает отключённых и удалённых участников', () => {
        ui.chat.detail = detail({conversation: {...detail().conversation, mode: 'group'}, participants: [participant({status: 'disabled'}), participant({agentId: 'deleted', name: 'Тестировщик', status: 'removed'})]});
        const html = render(createElement(ModelChatModal, {model, projectId: 'prj-one', onClose: ui.close})); expect(html).toContain('Разработчик · отключён'); expect(html).toContain('Тестировщик · удалён'); expect(ui.buttons.has('Участники')).toBe(true);
    });
});
