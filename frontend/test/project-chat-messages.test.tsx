import {harness, renderProjectUi, ui} from './project-chat-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProjectChatMessages} from '../src/features/ProjectChat/ProjectChatMessages';
import {projectMessage} from './project-chat-fixtures';

let props: Parameters<typeof ProjectChatMessages>[0];
const element = () => ProjectChatMessages(props);
beforeEach(() => {ui.flags.clear(); props = {messages: [], canReply: true, historyLoading: false, historyError: '', hasMore: false, onLoadEarlier: vi.fn(), onReply: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn()};});
afterEach(() => harness.dispose());
describe('Команда: авторы, replies и безопасная история', () => {
    it('Показывает имя каждого человека, агента и итог с цитатой исходного вопроса', () => {
        props.messages = [projectMessage(), projectMessage({id: 'bob', position: '2', author: {email: 'bob@example.test', displayName: 'Боб'}, content: 'Вопрос Боба'}), projectMessage({id: 'agent', position: '3', kind: 'agent', author: null, agent: {id: 'developer', name: 'Разработчик', slug: 'developer', modelId: 'model', modelPin: 'a'.repeat(64)}, content: 'Ответ по TypeScript', replyToId: 'bob', sourceMessageId: 'bob'}), projectMessage({id: 'summary', position: '4', kind: 'summary', content: '## TypeScript\nГотово', replyToId: 'bob', sourceMessageId: 'bob'})];
        const view = renderProjectUi(element); expect(view.html).toContain('Алиса'); expect(view.html).toContain('Боб'); expect(view.html).toContain('Ответ по TypeScript'); expect(view.html).toContain('Итог по стеку');
        ui.buttons.get('Ответить · Разработчик')!(); expect(props.onReply).toHaveBeenCalledWith(props.messages[2]); ui.buttons.get('Ответить · Боб')!(); expect(props.onReply).toHaveBeenCalledWith(props.messages[1]);
        expect(ui.buttons.has('Ответить · Итог по стеку')).toBe(false);
    });
    it('Выключенные флаги сохраняют историю и отмену, но отключают новый retry', () => {
        ui.flags.set('project_chat', false); ui.flags.set('group_chat', false); props.messages = [projectMessage({status: 'failed', canRetry: true, canCancel: true})]; props.canReply = false;
        const view = renderProjectUi(element); expect(view.html).toContain('Вопрос Алисы'); expect(ui.buttons.has('Повторить неуспешные ответы')).toBe(false); expect(ui.buttons.has('Ответить · Алиса')).toBe(false);
        ui.buttons.get('Остановить ответы')!(); expect(props.onCancel).toHaveBeenCalledWith('human-one');
    });
    it('Markdown ответа не запускает HTML, javascript-ссылки и внешние изображения', () => {
        props.messages = [projectMessage({kind: 'agent', content: '<script>alert(1)</script>\n\n[Запуск](javascript:alert(1))\n\n![секрет](https://evil.example/collect)\n\n[Документация](https://example.test/docs)'})];
        const view = renderProjectUi(element); expect(view.html).not.toContain('<script>'); expect(view.html).not.toContain('href="javascript:'); expect(view.html).not.toContain('<img'); expect(view.html).not.toContain('evil.example'); expect(view.html).toContain('href="https://example.test/docs"');
    });
    it('Потерянный ACK повтора можно проверить тем же запросом после выключения флагов', () => {
        ui.flags.set('project_chat', false); ui.flags.set('group_chat', false); props.messages = [projectMessage({status: 'running', canRetry: false})]; props.retryPending = ['human-one'];
        renderProjectUi(element); ui.buttons.get('Проверить повтор отправки')!(); expect(props.onRetry).toHaveBeenCalledWith('human-one');
    });
    it('Не позволяет отвечать на меняющийся placeholder агента, но разрешает durable вопрос человека', () => {
        props.messages = [projectMessage({status: 'running'}), projectMessage({id: 'pending-agent', kind: 'agent', status: 'running', content: 'Частичный ответ', agent: {id: 'developer', name: 'Разработчик', slug: 'developer', modelId: 'model', modelPin: 'a'.repeat(64)}})];
        renderProjectUi(element); expect(ui.buttons.has('Ответить · Алиса')).toBe(true); expect(ui.buttons.has('Ответить · Разработчик')).toBe(false);
    });
    it('Сводка ссылается на сообщения локально, ранняя ссылка предлагает подгрузить историю', () => {
        const id = 'b8bef921-28fe-4771-996e-ec304cba0978', old = 'cb99beaf-6ff8-457b-875b-70d4544d2a8f';
        props.hasMore = true; props.messages = [projectMessage({id}), projectMessage({id: 'summary', kind: 'summary', content: `[Исходный вопрос](#project-chat-message-${id})\n\n[Ранний ответ](#project-chat-message-${old})\n\n[Неверная ссылка](#arbitrary-anchor)`})];
        const view = renderProjectUi(element); expect(view.html).toContain(`href="#project-chat-message-${id}"`); expect(view.html).not.toContain('href="#arbitrary-anchor"'); expect(view.html).toContain('в ранней истории');
        ui.buttons.get('Показать связанное сообщение из ранней истории')!(); expect(props.onLoadEarlier).toHaveBeenCalledOnce();
    });
});
