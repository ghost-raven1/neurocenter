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
    it('Одно @ явно выбирает одного агента при people-only; подсказка ищет slug и имя', async () => {
        type('@reviewer проверь контракт'); const view = renderProjectUi(element);
        expect(view.html).toContain('@ заменяет выбор'); expect(view.html).toContain('запросов к моделям: 1');
        expect(ui.selects.get('Адресаты сообщения')!.value).toBe('people'); expect(ui.selects.get('Адресаты сообщения')!.disabled).toBe(true);
        const mentions = ui.mentions.get('Текст сообщения команде')!;
        expect(mentions.options.map(option => option.value)).toEqual(['developer', 'reviewer']);
        expect(mentions.filterOption('Ревью', {value: 'reviewer'})).toBe(true); expect(mentions.filterOption('REVIEW', {value: 'reviewer'})).toBe(true);
        ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element);
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({prompt: '@reviewer проверь контракт', targetAgentIds: ['reviewer']}));
    });
    it('Несколько @ дедуплицируются в порядке текста и перекрывают ручной group/selected выбор', async () => {
        type('Всем вопрос'); ui.selects.get('Адресаты сообщения')!.onChange('selected'); renderProjectUi(element); ui.selects.get('Агенты для ответа')!.onChange(['developer']);
        type('@reviewer @REVIEWER @developer сравните'); ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element);
        expect(onSend.mock.calls[0][0].targetAgentIds).toEqual(['reviewer', 'developer']);
        type('Черновик группы'); ui.selects.get('Адресаты сообщения')!.onChange('group'); type('@reviewer только проверка');
        ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element); expect(onSend.mock.calls[1][0].targetAgentIds).toEqual(['reviewer']);
    });
    it('После удаления @ возвращается прежний ручной выбор, черновик и reply сохраняются при remount', async () => {
        props.reply = projectMessage({id: 'bob-question', author: {email: 'bob@example.test', displayName: 'Боб'}}); renderProjectUi(element); renderProjectUi(element);
        type('Ручной выбор'); ui.selects.get('Адресаты сообщения')!.onChange('selected'); renderProjectUi(element); ui.selects.get('Агенты для ответа')!.onChange(['developer']);
        type('@reviewer проверь ответ'); harness.dispose(); let view = renderProjectUi(element); renderProjectUi(element);
        expect(view.html).toContain('@reviewer проверь ответ'); expect(view.html).toContain('Ответ · Боб');
        type('Обычный вопрос'); expect(ui.selects.get('Адресаты сообщения')!.value).toBe('selected'); ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element);
        expect(onSend.mock.calls[0][0]).toMatchObject({replyToId: 'bob-question', targetAgentIds: ['developer']});
        type('Ручной выбор снова'); ui.selects.get('Адресаты сообщения')!.onChange('group'); type('@reviewer временно'); type('Снова всем агентам'); view = renderProjectUi(element);
        expect(ui.selects.get('Адресаты сообщения')!.value).toBe('group'); expect(ui.selects.get('Адресаты сообщения')!.disabled).toBe(false);
        ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element); expect(onSend.mock.calls[1][0].targetAgentIds).toEqual(['developer', 'reviewer']);
    });
    it.each(['@unknown вопрос', '@developer @unknown вопрос', '@ вопрос'])('Невалидное упоминание %s не рассылает группе и не отправляет людям', async body => {
        type('Группа'); ui.selects.get('Адресаты сообщения')!.onChange('group'); type(body); const view = renderProjectUi(element);
        expect(ui.buttons.has('Спросить агентов')).toBe(false); expect(view.html).toContain('подсказки'); expect(onSend).not.toHaveBeenCalled();
        ui.mentions.get('Текст сообщения команде')!.onPressEnter({key: 'Enter', shiftKey: false, defaultPrevented: false, keyCode: 13, nativeEvent: {isComposing: false}, preventDefault: vi.fn()});
        await settleProjectUi(element); expect(onSend).not.toHaveBeenCalled();
    });
    it('Inactive и агент вне room отсутствуют в подсказках и блокируют явное @', async () => {
        props.detail.agents = [...props.detail.agents.map(agent => agent.agentId === 'reviewer' ? {...agent, status: 'disabled' as const, reason: 'Модель отключена'} : agent), {agentId: 'outsider', name: 'Другой агент', slug: 'outsider', status: 'active'}];
        type('@reviewer вопрос'); let view = renderProjectUi(element); expect(ui.mentions.get('Текст сообщения команде')!.options.map(option => option.value)).toEqual(['developer']); expect(view.html).toContain('Модель отключена'); expect(ui.buttons.has('Спросить агентов')).toBe(false);
        type('@outsider вопрос'); view = renderProjectUi(element); expect(view.html).toContain('не найден'); expect(onSend).not.toHaveBeenCalled();
        type('Людям без агента'); ui.buttons.get('Отправить')!(); await settleProjectUi(element); expect(onSend.mock.calls[0][0].targetAgentIds).toEqual([]);
    });
    it('Email и @ внутри кода не включают inference, в том числе без агентов', async () => {
        props.detail.room.agentIds = []; props.detail.agents = []; type('Почта alice@example.test, код `@reviewer` и ```\n@developer\n```');
        ui.buttons.get('Отправить')!(); await settleProjectUi(element); expect(onSend.mock.calls[0][0].targetAgentIds).toEqual([]);
    });
    it('Флаги запрещают новое @ inference, но после удаления @ люди продолжают переписку', async () => {
        ui.flags.set('group_chat', false); type('@reviewer вопрос'); let view = renderProjectUi(element); expect(ui.mentions.get('Текст сообщения команде')!.options).toEqual([]);
        ui.buttons.get('Спросить агентов')!(); view = await settleProjectUi(element); expect(onSend).not.toHaveBeenCalled(); expect(view.html).toContain('Уберите @адресатов');
        type('Вопрос коллегам'); ui.buttons.get('Отправить')!(); await settleProjectUi(element); expect(onSend.mock.calls[0][0].targetAgentIds).toEqual([]);
        ui.flags.set('project_chat', false); type('@reviewer новый вопрос'); expect(ui.inputs.get('Текст сообщения команде')!.disabled).toBe(true); expect(ui.buttons.has('Спросить агентов')).toBe(false);
    });
    it('Неизвестный ACK замораживает ordered @ IDs/reply даже при смене roster и выключении флагов', async () => {
        props.reply = projectMessage({id: 'question'}); onSend.mockRejectedValueOnce(new Error('ACK lost')); renderProjectUi(element); renderProjectUi(element);
        type('@reviewer @developer ответьте'); ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element); const sent = onSend.mock.calls[0][0];
        expect(sent).toMatchObject({targetAgentIds: ['reviewer', 'developer'], replyToId: 'question'});
        props.detail = projectRoom({room: {...props.detail.room, agentIds: []}, agents: [], canPost: false}); ui.flags.set('project_chat', false); ui.flags.set('group_chat', false); renderProjectUi(element);
        ui.buttons.get('Проверить отправку')!(); await settleProjectUi(element); expect(onSend.mock.calls[1][0]).toEqual(sent);
    });
    it('onPressEnter respects popup consumption, Shift+Enter and both IME signals before submission', async () => {
        type('@reviewer готовый вопрос'); const enter = (extra: Record<string, unknown> = {}) => ({key: 'Enter', shiftKey: false, defaultPrevented: false, keyCode: 13, nativeEvent: {isComposing: false}, preventDefault: vi.fn(), ...extra});
        let mentions = ui.mentions.get('Текст сообщения команде')!;
        mentions.onPressEnter(enter({defaultPrevented: true})); mentions.onPressEnter(enter({shiftKey: true})); mentions.onPressEnter(enter({nativeEvent: {isComposing: true}})); mentions.onPressEnter(enter({keyCode: 229}));
        mentions.onCompositionStart(); mentions.onPressEnter(enter()); mentions.onCompositionEnd(); expect(onSend).not.toHaveBeenCalled();
        renderProjectUi(element); mentions = ui.mentions.get('Текст сообщения команде')!; mentions.onPressEnter(enter()); await settleProjectUi(element); expect(onSend).toHaveBeenCalledOnce();
        expect(onSend.mock.calls[0][0].targetAgentIds).toEqual(['reviewer']);
    });
    it('Reply на исторического агента вне room не подставляет его в новый selected запрос', async () => {
        props.detail.room.agentIds = ['developer'];
        props.reply = projectMessage({id: 'old-agent-answer', kind: 'agent', author: null, agent: {id: 'reviewer', name: 'Ревьюер', slug: 'reviewer', modelId: 'model', modelPin: 'a'.repeat(64)}});
        renderProjectUi(element); renderProjectUi(element); type('Исторический ответ'); ui.selects.get('Адресаты сообщения')!.onChange('selected'); renderProjectUi(element);
        expect(ui.selects.get('Агенты для ответа')!.value).toEqual([]); ui.buttons.get('Спросить агентов')!(); const view = await settleProjectUi(element);
        expect(view.html).toContain('Выберите доступного агента'); expect(onSend).not.toHaveBeenCalled();
        ui.selects.get('Агенты для ответа')!.onChange(['developer']); renderProjectUi(element); ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element);
        expect(onSend.mock.calls[0][0]).toMatchObject({replyToId: 'old-agent-answer', targetAgentIds: ['developer']});
    });
    it('Ручной адресат, удалённый из room после выбора, не отправляется даже если активен в проекте', async () => {
        type('Ручной вопрос'); ui.selects.get('Адресаты сообщения')!.onChange('selected'); renderProjectUi(element); ui.selects.get('Агенты для ответа')!.onChange(['reviewer']);
        props.detail = {...props.detail, room: {...props.detail.room, agentIds: ['developer']}}; renderProjectUi(element); ui.buttons.get('Спросить агентов')!(); const view = await settleProjectUi(element);
        expect(onSend).not.toHaveBeenCalled(); expect(view.html).toContain('Среди адресатов есть недоступный агент');
        ui.selects.get('Адресаты сообщения')!.onChange('people'); renderProjectUi(element); ui.buttons.get('Отправить')!(); await settleProjectUi(element);
        expect(onSend.mock.calls[0][0].targetAgentIds).toEqual([]);
    });
    it('Каноническое @slug из подсказки не блокируется совпадающим именем другого агента', async () => {
        props.detail.agents = props.detail.agents.map(agent => agent.agentId === 'developer' ? {...agent, name: 'reviewer'} : agent);
        type('@reviewer проверь'); const option = ui.mentions.get('Текст сообщения команде')!.options.find(value => value.value === 'reviewer'); expect(option?.label).toContain('Ревьюер');
        ui.buttons.get('Спросить агентов')!(); await settleProjectUi(element); expect(onSend.mock.calls[0][0].targetAgentIds).toEqual(['reviewer']);
    });
    it.each([true, false])('Пустая группа даёт понятный путь для canConfigure=%s и сохраняет отправку людям после удаления @', async canConfigure => {
        props.detail = projectRoom({room: {...props.detail.room, agentIds: []}, agents: [], canConfigure}); type('@'); let view = renderProjectUi(element);
        const action = canConfigure ? 'Откройте «Настроить агентов»' : 'Попросите администратора проекта добавить агентов';
        expect(view.html).toContain('В группе нет агентов'); expect(view.html).toContain(action); expect(view.html).toContain('уберите @');
        expect(view.html).not.toContain('выберите имя из подсказки'); expect(ui.mentions.get('Текст сообщения команде')!.notFoundContent).toContain(action); expect(ui.buttons.has('Спросить агентов')).toBe(false);
        ui.mentions.get('Текст сообщения команде')!.onPressEnter({key: 'Enter', shiftKey: false, defaultPrevented: false, keyCode: 13, nativeEvent: {isComposing: false}, preventDefault: vi.fn()});
        view = await settleProjectUi(element); expect(view.html).toContain(action); expect(onSend).not.toHaveBeenCalled();
        type('Вопрос коллегам'); ui.buttons.get('Отправить')!(); await settleProjectUi(element); expect(onSend.mock.calls[0][0].targetAgentIds).toEqual([]);
    });
});
