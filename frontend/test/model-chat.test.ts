import { describe, expect, it, vi } from 'vitest';
import type { ICatalogModel } from '../src/features/ModelCatalog/types';
import type { IModelChatTurn } from '../src/features/ModelChat/types';
import { modelChatAnswer, modelChatContextError, modelChatIdentity, modelChatMessages, modelChatPromptError, modelChatUnavailableReason, modelChatUrl } from '../src/features/ModelChat/model';
import { sendModelChat } from '../src/features/ModelChat/api';
import api from '../src/core/api/base';

vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn() } }));
const model: ICatalogModel = { id: 'model/chat', name: 'Chat', description: '', runtime: 'remote-openai', model: 'upstream-model', modelVersion: '1', capability: 'chat', dimension: null, manifestSha256: null, verificationSha256: 'a'.repeat(64), modelPin: 'c'.repeat(64), source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const completed = (id = 1): IModelChatTurn => ({ id, prompt: 'Вопрос', status: 'done', answer: { content: 'Ответ', finishReason: 'stop' } });
const response = (content = 'Ответ', finish_reason = 'stop') => ({ model: model.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }] });

describe('Право на текстовый чат и идентичность модели', () => {
    it('Разрешает рабочую роль в назначенном проекте и main в общем каталоге', () => {
        expect(modelChatUnavailableReason(model, true, true, true)).toBe('');
        expect(modelChatUnavailableReason(model, true, false, false)).toBe('');
        expect(modelChatUnavailableReason(model, false, true, true)).toContain('рабочая роль');
        expect(modelChatUnavailableReason(model, true, true, false)).toContain('добавьте модель');
        expect(modelChatUnavailableReason(model, false, false, false)).toContain('Выберите проект');
    });
    it('Сохраняет назначенную архивную модель и не предлагает чат embedding или непроверенной модели', () => {
        expect(modelChatUnavailableReason({ ...model, archivedAt: '2026-10-21' }, true, true, true)).toBe('');
        expect(modelChatUnavailableReason({ ...model, archivedAt: '2026-10-21' }, true, false, false)).toContain('убрана');
        expect(modelChatUnavailableReason({ ...model, capability: 'embedding' }, true, true, true)).toContain('поиска');
        expect(modelChatUnavailableReason({ ...model, verificationSha256: null }, true, false, false)).toContain('проверьте подключение');
        expect(modelChatUnavailableReason({ ...model, runtime: 'ollama' }, true, true, true)).toContain('на сервере');
        expect(modelChatUnavailableReason({ ...model, runtime: 'ollama', manifestSha256: 'b'.repeat(64) }, true, true, true)).toBe('');
        expect(modelChatUnavailableReason({ ...model, capability: 'vision' }, true, true, true)).toBe('');
    });
    it('Имя и описание не сбрасывают контекст, протокол, версия и проверенный pin меняют идентичность', () => {
        const identity = modelChatIdentity(model);
        expect(modelChatIdentity({ ...model, revision: 2, name: 'Переименована', description: 'Описание' })).toBe(identity);
        for (const patch of [{ model: 'other' }, { runtime: 'remote-ollama' as const }, { modelVersion: '2' }, { verificationSha256: 'b'.repeat(64) }, { modelPin: 'd'.repeat(64) }, { capability: 'vision' as const }])
            expect(modelChatIdentity({ ...model, ...patch })).not.toBe(identity);
    });
});

describe('Полная история и ограничения контекста', () => {
    it('Передаёт каждый завершённый обмен и ровно одно ожидающее сообщение без метаданных', () => {
        expect(modelChatMessages([completed(), { id: 2, prompt: 'Дальше', status: 'pending' }])).toEqual([
            { role: 'user', content: 'Вопрос' }, { role: 'assistant', content: 'Ответ' }, { role: 'user', content: 'Дальше' },
        ]);
    });
    it('Не усекает контекст у предела 40 сообщений, не считает failed ответом', () => {
        const nineteen = Array.from({ length: 19 }, (_, id) => completed(id));
        expect(modelChatPromptError('Новый', nineteen)).toBe('');
        expect(modelChatPromptError('Новый', [...nineteen, completed(20)])).toContain('40 сообщений');
        expect(modelChatPromptError('Новый', [{ id: 1, prompt: 'Не получился', status: 'failed' }])).toContain('последнее сообщение');
    });
    it('Проверяет UTF-8 байты, не изменяя пробелы и отступы содержимого', () => {
        expect(modelChatPromptError(' \n\t ', [])).toContain('Введите');
        expect(modelChatPromptError('я'.repeat(65536), [])).toBe('');
        expect(modelChatPromptError('я'.repeat(65537), [])).toContain('128 КиБ');
        expect(modelChatPromptError('  код\n  с отступом', [])).toBe('');
    });
    it('Показывает длинный настоящий ответ, но явно запрещает передать его дальше сверх лимита сервера', () => {
        const answer = modelChatAnswer(response('x'.repeat(131073)), model.model);
        expect(answer.content.length).toBe(131073);
        expect(modelChatContextError([{ ...completed(), answer }])).toContain('слишком большой');
    });
    it('Учитывает сериализованный размер всего запроса, включая JSON-экранирование управляющих символов', () => {
        const content = '\u0000'.repeat(131072), previous = Array.from({ length: 5 }, (_, id) => ({ ...completed(id), prompt: content, answer: { content, finishReason: 'stop' as const } }));
        expect(modelChatContextError(previous)).toBe('');
        expect(modelChatPromptError(content, previous)).toContain('8 МиБ');
        expect(modelChatContextError([...previous, { ...completed(6), prompt: content, answer: { content, finishReason: 'stop' } }])).toContain('8 МиБ');
    });
});

describe('Ответы и безопасный Markdown', () => {
    it('Отличает завершённый ответ от исчерпанного лимита', () => {
        expect(modelChatAnswer(response(), model.model)).toEqual({ content: 'Ответ', finishReason: 'stop' });
        expect(modelChatAnswer(response('Продолжение…', 'length'), model.model).finishReason).toBe('length');
    });
    it.each([null, {}, { ...response(), model: 'another' }, { ...response(), choices: [] }, response(''), response(' \n '), response('content', 'tool_calls'),
        { ...response(), choices: [{ index: 1, message: { role: 'assistant', content: 'Ответ' }, finish_reason: 'stop' }] },
        { ...response(), choices: [{ index: 0, message: { role: 'user', content: 'Ответ' }, finish_reason: 'stop' }] },
    ])('Не принимает неполный, пустой или чужой ответ %#', value => { expect(() => modelChatAnswer(value, model.model)).toThrow('некорректный ответ'); });
    it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//remote.example/image.png', '/internal', 'https://user:password@example.test'])('Не открывает опасный или неявный адрес %s', url => {
        expect(modelChatUrl(url)).toBeUndefined();
    });
    it('Разрешает явные HTTP(S) ссылки', () => {
        expect(modelChatUrl('https://example.test/path?q=1')).toBe('https://example.test/path?q=1');
        expect(modelChatUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/');
    });
});

describe('Запрос через Gateway', () => {
    it.each([undefined, 'prj-example'])('Отправляет историю и scope %s без ключа, адреса провайдера и принудительных параметров', async projectId => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: response() });
        const abort = new AbortController(), messages = [{ role: 'user' as const, content: 'Вопрос' }];
        await expect(sendModelChat(model, messages, projectId, abort.signal)).resolves.toEqual({ content: 'Ответ', finishReason: 'stop' });
        expect(api.post).toHaveBeenLastCalledWith('/api/models/model%2Fchat/ollama/v1/chat/completions', { messages, stream: false },
            { params: { ...(projectId ? { projectId } : {}), expectedModelPin: model.modelPin }, signal: abort.signal, timeout: 620000 });
    });
    it.each([undefined, '', 'wrong-pin', 'A'.repeat(64)])('Без точного pin %s не отправляет запрос', async modelPin => {
        vi.mocked(api.post).mockClear();
        await expect(sendModelChat({ ...model, modelPin }, [{ role: 'user', content: 'Вопрос' }], undefined, new AbortController().signal)).rejects.toThrow('Обновите каталог');
        expect(api.post).not.toHaveBeenCalled();
    });
});
