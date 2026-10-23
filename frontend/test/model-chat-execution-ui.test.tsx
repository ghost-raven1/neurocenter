import {harness, renderProjectUi, ui} from './project-chat-ui-fixture';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ChatAnswer} from '../src/features/ModelChat/ChatAnswer';

beforeEach(() => ui.flags.clear());
afterEach(() => harness.dispose());
describe('Выключенные статусы сохраняют правдивое ожидание ответа', () => {
    it.each(['waiting', 'running'] as const)('OFF не выдаёт %s за новую очередь и не прячет pending', executionState => {
        ui.flags.set('chat_activity', false);
        const html = renderProjectUi(() => <ChatAnswer name="Разработчик" group status="pending" executionState={executionState}/>).html;
        expect(html).toContain('Ожидаем ответ…'); expect(html).not.toContain('готовит ответ'); expect(html).not.toContain('Ожидаем начало');
    });
});
