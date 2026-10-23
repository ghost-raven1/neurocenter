import {harness, renderProjectUi, settleProjectUi, ui} from './project-chat-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProjectChatComposer} from '../src/features/ProjectChat/ProjectChatComposer';
import {projectMessage, projectRoom} from './project-chat-fixtures';
import type {ProjectChatReceipt} from '../src/features/ProjectChat/types';

let key = 0;
let props: Parameters<typeof ProjectChatComposer>[0];
const onSend = vi.fn<Parameters<typeof ProjectChatComposer>[0]['onSend']>(), cancelReply = vi.fn();
const element = () => ProjectChatComposer(props);
const type = (body: string) => {renderProjectUi(element); ui.inputs.get('Текст сообщения команде')!.onChange({target: {value: body}}); renderProjectUi(element);};
beforeEach(() => {vi.clearAllMocks(); ui.flags.clear(); ui.owner = 'alice'; props = {draftKey: 'composer-' + (++key), detail: projectRoom(), onCancelReply: cancelReply, onSend}; onSend.mockResolvedValue({message: projectMessage(), roomRevision: 2});});
afterEach(() => harness.dispose());

describe('Команда: явная отправка и безопасные ответы', () => {
    it('По умолчанию пишет людям без модельного запроса; работающие агенты не блокируют новый вопрос', async () => {
        props.detail.messages = [projectMessage({status: 'running'})]; type('Коллеги, обсудим?');
        expect(ui.selects.get('Адресаты сообщения')!.value).toBe('people'); ui.buttons.get('Отправить')!(); await settleProjectUi(element);
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({prompt: 'Коллеги, обсудим?', targetAgentIds: []}));
        type('Ещё один вопрос'); expect(ui.buttons.has('Отправить')).toBe(true); ui.buttons.get('Отправить')!(); await settleProjectUi(element);
        expect(onSend).toHaveBeenCalledTimes(2); expect(onSend.mock.calls[1][0].requestKey).not.toBe(onSend.mock.calls[0][0].requestKey);
    });
    it('Явный вопрос выбранному агенту содержит reply на его сообщение и точного адресата', async () => {
        props.reply = projectMessage({id: 'agent-answer', kind: 'agent', author: null, agent: {id: 'reviewer', name: 'Ревьюер', slug: 'reviewer', modelId: 'model', modelPin: 'a'.repeat(64)}});
        renderProjectUi(element); renderProjectUi(element); type('Проверь это изменение');
        expect(ui.selects.get('Адресаты сообщения')!.value).toBe('people');
        ui.selects.get('Адресаты сообщения')!.onChange('selected'); const view = renderProjectUi(element);
        expect(view.html).toContain('Ревьюер'); expect(view.html).toContain('запросов к моделям: 1'); expect(ui.selects.get('Агенты для ответа')!.value).toEqual(['reviewer']);
        ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element);
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({replyToId: 'agent-answer', targetAgentIds: ['reviewer']}));
    });
    it('Reply на человека не запускает агентов автоматически и сохраняет автора цитаты', async () => {
        props.reply = projectMessage({id: 'bob-question', author: {email: 'bob@example.test', displayName: 'Боб'}});
        renderProjectUi(element); const view = renderProjectUi(element); expect(view.html).toContain('Ответ · Боб');
        type('Да, согласна'); ui.buttons.get('Отправить')!(); await settleProjectUi(element);
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({replyToId: 'bob-question', targetAgentIds: []}));
    });
    it('Неизвестный ACK повторяет тот же ключ/текст/ответ/агентов даже после выключения флагов', async () => {
        props.reply = projectMessage(); onSend.mockRejectedValueOnce(new Error('ACK lost'));
        renderProjectUi(element); renderProjectUi(element); type('Вопрос по стеку'); ui.selects.get('Адресаты сообщения')!.onChange('group'); renderProjectUi(element); ui.buttons.get('Спросить агентов')!();
        let view = await settleProjectUi(element); const sent = onSend.mock.calls[0][0];
        expect(view.html).toContain('Вопрос по стеку'); expect(ui.inputs.get('Текст сообщения команде')!.disabled).toBe(true);
        ui.flags.set('project_chat', false); ui.flags.set('group_chat', false); props.detail = {...props.detail, canPost: false}; renderProjectUi(element); ui.buttons.get('Проверить отправку')!(); view = await settleProjectUi(element);
        expect(onSend.mock.calls[1][0]).toEqual(sent); expect(cancelReply).toHaveBeenCalledOnce(); expect(view.html).not.toContain('Вопрос по стеку');
    });
    it('Выключение group_chat сохраняет обычную переписку людей', async () => {
        ui.flags.set('group_chat', false); type('Работаем без модели'); ui.buttons.get('Отправить')!(); await settleProjectUi(element);
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({targetAgentIds: []}));
        type('Спросить отключённого агента'); ui.selects.get('Адресаты сообщения')!.onChange('group'); renderProjectUi(element); ui.buttons.get('Спросить агентов')!();
        const view = await settleProjectUi(element); expect(onSend).toHaveBeenCalledOnce(); expect(view.html).toContain('Только участникам проекта');
    });
    it('Определённый отказ сохраняет редактируемый текст и адресата', async () => {
        onSend.mockRejectedValueOnce({isAxiosError: true, response: {status: 400, data: {message: 'Модель не готова'}}}); type('Не потерять'); ui.buttons.get('Отправить')!();
        const view = await settleProjectUi(element); expect(view.html).toContain('Не потерять'); expect(ui.inputs.get('Текст сообщения команде')!.disabled).toBe(false); expect(ui.buttons.has('Проверить отправку')).toBe(false);
    });
    it('Поздний ACK прежнего пользователя не очищает его черновик и не трогает новый контекст', async () => {
        let resolve!: (value: ProjectChatReceipt) => void; onSend.mockReturnValueOnce(new Promise(done => {resolve = done;})); type('Личный черновик Алисы'); ui.buttons.get('Отправить')!();
        ui.owner = 'bob'; resolve({message: projectMessage(), roomRevision: 2}); await settleProjectUi(element); expect(cancelReply).not.toHaveBeenCalled();
        const original = props.draftKey; harness.dispose(); props = {...props, draftKey: 'bob:prj-two'}; renderProjectUi(element); expect(ui.inputs.get('Текст сообщения команде')!.value).toBe('');
        harness.dispose(); props = {...props, draftKey: original}; renderProjectUi(element); expect(ui.inputs.get('Текст сообщения команде')!.value).toBe('Личный черновик Алисы');
    });
    it('Лимит проверяется по UTF-8 до запроса, повторный синхронный клик не дублирует сообщение', async () => {
        type('界'.repeat(44000)); ui.buttons.get('Отправить')!(); let view = await settleProjectUi(element); expect(onSend).not.toHaveBeenCalled(); expect(view.html).toContain('128 КиБ');
        let resolve!: (value: ProjectChatReceipt) => void; onSend.mockReturnValueOnce(new Promise(done => {resolve = done;})); type('Один запрос'); const submit = ui.buttons.get('Отправить')!; submit(); submit(); expect(onSend).toHaveBeenCalledOnce();
        resolve({message: projectMessage(), roomRevision: 2}); view = await settleProjectUi(element); expect(view.html).not.toContain('Один запрос');
    });
});
