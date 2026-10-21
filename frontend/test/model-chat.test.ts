import {beforeEach, describe, expect, it, vi} from 'vitest';
import {modelChatPromptError, modelChatUnavailableReason, modelChatUrl, sortedModelChats} from '../src/features/ModelChat/model';
import {chatFileError, chatFileSize} from '../src/features/ModelChat/files';
import {modelChatApi} from '../src/features/ModelChat/api';
import api from '../src/core/api/base';
import {detail, model, turn} from './model-chat-fixtures';

vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn()}}));
beforeEach(() => vi.clearAllMocks());

describe('Права, модель и сохранённый контекст', () => {
    it('Разрешает чат только рабочей роли с назначенной проверенной моделью', () => {
        expect(modelChatUnavailableReason(model, true, true, true)).toBe('');
        expect(modelChatUnavailableReason(model, false, true, true)).toContain('рабочая роль');
        expect(modelChatUnavailableReason(model, true, true, false)).toContain('добавьте модель');
        expect(modelChatUnavailableReason({...model, capability: 'embedding'}, true, true, true)).toContain('поиска');
        expect(modelChatUnavailableReason({...model, verificationSha256: null}, true, false, false)).toContain('проверьте подключение');
        expect(modelChatUnavailableReason({...model, archivedAt: 'now'}, true, true, true)).toBe('');
        expect(modelChatUnavailableReason({...model, archivedAt: 'now'}, true, false, false)).toContain('убрана');
    });
    it('Разрешает документ без текста; отвергает пустой ввод, незавершённый хвост и превышение UTF8', () => {
        expect(modelChatPromptError('', ['attachment-1'], detail())).toBe('');
        expect(modelChatPromptError(' \n ', [], null)).toContain('прикрепите');
        expect(modelChatPromptError('я'.repeat(65536), [], detail())).toBe('');
        expect(modelChatPromptError('я'.repeat(65537), [], detail())).toContain('128 КиБ');
        expect(modelChatPromptError('Ещё', [], detail({turns: [turn({status: 'failed'})]}))).toContain('последнее');
    });
    it('Обновляет запись диалога без дубликата и сортирует по изменению', () => {
        const first = detail().conversation, second = {...first, id: 'chat-2', updatedAt: '2026-10-22'};
        expect(sortedModelChats([first, second], {...first, title: 'Новое название', updatedAt: '2026-10-23'}).map(value => [value.id, value.title])).toEqual([['chat-1', 'Новое название'], ['chat-2', first.title]]);
    });
});

describe('Вложения: обратная связь до серверной проверки', () => {
    it.each(['guide.pdf', 'file.docx', 'file.md', 'file.csv', 'code.ts', 'code.py', 'text.tsv', 'trace.jsonl', 'config.graphql', '.gitignore', '.editorconfig', 'Dockerfile', 'Makefile'])('Разрешает %s', name => expect(chatFileError({name, size: 10})).toBe(''));
    it.each(['photo.png', 'scan.jpg', 'archive.zip', 'document.doc', 'file.exe', 'code.jsonc'])('Объясняет неподдерживаемый формат %s', name => expect(chatFileError({name, size: 10})).toContain('OCR'));
    it('Проверяет пустые файлы и точную границу 10 МиБ', () => {
        expect(chatFileError({name: 'a.txt', size: 0})).toContain('Пустой');
        expect(chatFileError({name: 'a.txt', size: 10 * 1024 * 1024})).toBe('');
        expect(chatFileError({name: 'a.txt', size: 10 * 1024 * 1024 + 1})).toContain('10 МиБ');
        expect(chatFileSize(1024)).toBe('1 КиБ');
    });
});

describe('Безопасный вывод', () => {
    it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//host.test/x', '/internal', 'https://user:password@host.test'])('Не открывает %s', value => expect(modelChatUrl(value)).toBeUndefined());
    it('Разрешает явную HTTPS-ссылку', () => expect(modelChatUrl('https://docs.example.test/guide')).toBe('https://docs.example.test/guide'));
});

describe('Серверная история через Gateway', () => {
    it('Создаёт чат с model pin и project scope без ключа/адреса провайдера', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({data: detail()}); const controller = new AbortController();
        await expect(modelChatApi.create(model, 'prj-one', controller.signal)).resolves.toEqual(detail());
        expect(api.post).toHaveBeenCalledWith('/api/model-chats', {modelId: model.id, projectId: 'prj-one', expectedModelPin: model.modelPin}, {signal: controller.signal});
    });
    it('Отправляет ID вложений и idempotency key; историю составляет сервер', async () => {
        vi.mocked(api.post).mockResolvedValueOnce({data: detail({turns: [turn()]})}); const signal = new AbortController().signal;
        await modelChatApi.send(detail(), model, 'uuid-request', 'Вопрос', ['attachment-1'], signal);
        expect(api.post).toHaveBeenCalledWith('/api/model-chats/chat-1/turns', {expectedRevision: 1, requestId: 'uuid-request', prompt: 'Вопрос', attachmentIds: ['attachment-1'], expectedModelPin: model.modelPin}, {signal, timeout: 620000});
    });
    it('Отдельно передаёт документ и отмену с CAS-ревизией', async () => {
        vi.mocked(api.post).mockResolvedValue({data: detail()}); const signal = new AbortController().signal;
        await modelChatApi.upload('chat/one', 'report.txt', 'dGVzdA==', 'uuid-file', signal);
        expect(api.post).toHaveBeenLastCalledWith('/api/model-chats/chat%2Fone/attachments', {name: 'report.txt', contentBase64: 'dGVzdA==', requestId: 'uuid-file'}, {signal, timeout: 120000});
        await modelChatApi.cancel(detail(), 'turn/1', signal);
        expect(api.post).toHaveBeenLastCalledWith('/api/model-chats/chat-1/turns/turn%2F1/cancel', {expectedRevision: 1}, {signal});
    });
    it('Не обращается к API без точного pin', () => {
        expect(() => modelChatApi.create({...model, modelPin: undefined}, undefined, new AbortController().signal)).toThrow('Обновите каталог');
        expect(api.post).not.toHaveBeenCalled();
    });
});
