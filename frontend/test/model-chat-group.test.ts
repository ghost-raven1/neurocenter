import {beforeEach, describe, expect, it, vi} from 'vitest';
import api from '../src/core/api/base';
import {modelChatApi} from '../src/features/ModelChat/api';
import {chatMentions, chatRecipients} from '../src/features/ModelChat/participants';
import {detail, model, participant} from './model-chat-fixtures';

vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn(), put: vi.fn()}}));
const agents = [participant(), participant({agentId: 'agent-review', slug: 'nc-reviewer', name: 'Ревьюер'})];
beforeEach(() => vi.clearAllMocks());

describe('Адресация существующим участникам группы', () => {
    it('Чистый parser не вводит default group eligibility в people-only переписку', () => {
        expect(chatMentions('Вопрос людям', [])).toEqual({ids: [], hasMentions: false});
        const inactive = [participant({status: 'disabled'})];
        expect(chatMentions('Почта dev@example.test и `@nc-developer`', inactive)).toEqual({ids: [], hasMentions: false});
        expect(chatRecipients('Вопрос людям', inactive).error).toContain('Добавьте');
        expect(chatMentions('@nc-developer вопрос', inactive)).toMatchObject({ids: [], hasMentions: true, error: expect.any(String)});
    });
    it('Чистый parser возвращает только explicit IDs, сохраняя текстовый порядок и ошибки вместо broadcast', () => {
        expect(chatMentions('@nc-reviewer @NC-DEVELOPER @nc-reviewer', agents)).toEqual({ids: ['agent-review', 'agent-dev'], hasMentions: true});
        expect(chatMentions('@nc-developer @unknown', agents)).toMatchObject({ids: [], hasMentions: true, error: expect.stringContaining('не найден')});
    });
    it('Канонический slug из подсказки имеет приоритет над совпавшим отображаемым именем другого агента', () => {
        const collision = [participant({agentId: 'review', slug: 'reviewer', name: 'Ревьюер'}), participant({agentId: 'test', slug: 'tester', name: 'reviewer'})];
        expect(chatMentions('@REVIEWER проверь', collision)).toEqual({ids: ['review'], hasMentions: true});
        expect(chatRecipients('@reviewer проверь', collision)).toEqual({ids: ['review']});
        expect(chatMentions('@reviewer', [...collision, participant({agentId: 'duplicate', slug: 'Reviewer', name: 'Другой'})]).error).toContain('неоднозначен');
    });
    it('Без упоминания адресует всем выбранным; не принимает email и inline/fenced code за адресата', () => {
        for (const text of ['Вопрос всем', 'dev@example.test', '`@unknown`', '```ts\n@unknown\n```']) expect(chatRecipients(text, agents)).toEqual({ids: []});
    });
    it('Адресует одному или нескольким по уникальному slug/имени и удаляет повторы', () => {
        expect(chatRecipients('@nc-developer, проверь.\n@Ревьюер посмотри. @nc-developer', agents)).toEqual({ids: ['agent-dev', 'agent-review']});
        expect(chatRecipients('Проверь (@nc-developer), пожалуйста', agents)).toEqual({ids: ['agent-dev']});
        expect(chatRecipients('Обращение: «@nc-developer»', agents)).toEqual({ids: ['agent-dev']});
    });
    it.each(['@', '@ ', '@bad/address', '@nc-developer,@nc-reviewer'])('Незавершённая/неверная адресация %s не рассылает всем', prompt => expect(chatRecipients(prompt, agents).error).toBeTruthy());
    it('Не рассылает всем при опечатке или неоднозначном имени', () => {
        expect(chatRecipients('@nc-missing проверь', agents).error).toContain('не найден');
        expect(chatRecipients('@Ревьюер проверь', [...agents, participant({agentId: 'other', slug: 'nc-other', name: 'Ревьюер'})]).error).toContain('неоднозначен');
    });
    it.each(['disabled', 'removed', 'blocked'] as const)('Показывает причину %s; явный доступный адресат работает независимо от других', status => {
        const values = [agents[0], {...agents[1], status, reason: 'Нужно исправить подключение'}];
        expect(chatRecipients('Всем', values).error).toContain('недоступные');
        expect(chatRecipients('@nc-reviewer', values).error).toContain('Нужно исправить подключение');
        expect(chatRecipients('@nc-developer', values)).toEqual({ids: ['agent-dev']});
    });
    it('Пустая группа не считается готовой к отправке', () => expect(chatRecipients('Вопрос', []).error).toContain('Добавьте'));
});

describe('Группа через аутентифицированный Gateway', () => {
    it('Читает только участников выбранного проекта/модели до создания', async () => {
        vi.mocked(api.get).mockResolvedValueOnce({data: {items: agents}}); const signal = new AbortController().signal;
        await expect(modelChatApi.agents(model.id, 'prj-one', signal)).resolves.toEqual(agents);
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/model-chats/agents', {params: {modelId: model.id, projectId: 'prj-one'}, signal});
    });
    it('Создаёт группу и меняет участников с CAS, передаёт явных адресатов preview/send', async () => {
        vi.mocked(api.post).mockResolvedValue({data: detail()}); vi.mocked(api.put).mockResolvedValue({data: detail()}); const signal = new AbortController().signal;
        await modelChatApi.create(model, 'prj-one', signal, ['agent-dev']);
        expect(api.post).toHaveBeenLastCalledWith('/api/model-chats', {modelId: model.id, projectId: 'prj-one', expectedModelPin: model.modelPin, mode: 'group', agentIds: ['agent-dev']}, {signal});
        await modelChatApi.participants(detail(), ['agent-review'], signal);
        expect(api.put).toHaveBeenCalledExactlyOnceWith('/api/model-chats/chat-1/participants', {expectedRevision: 1, agentIds: ['agent-review']}, {signal});
        await modelChatApi.context('chat-1', '@nc-developer', [], signal, ['agent-dev']);
        expect(api.post).toHaveBeenLastCalledWith('/api/model-chats/chat-1/context-preview', {prompt: '@nc-developer', attachmentIds: [], targetAgentIds: ['agent-dev']}, {signal});
        await modelChatApi.send(detail(), model, 'request', '@nc-developer', [], signal, ['agent-dev']);
        expect(api.post).toHaveBeenLastCalledWith('/api/model-chats/chat-1/turns', expect.objectContaining({targetAgentIds: ['agent-dev']}), {signal, timeout: 920000});
    });
    it('Завершает частичный раунд без удаления успешных ответов', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({data: detail()}); const signal = new AbortController().signal;
        await modelChatApi.complete(detail(), 'turn/one', signal);
        expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/model-chats/chat-1/turns/turn%2Fone/complete', {expectedRevision: 1}, {signal});
    });
});
