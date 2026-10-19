import { describe, expect, it } from 'vitest';

import type { ISkillFile } from '../src/core/api/interfaces';
import { editMcpConfig, editTags, skillEditPayload, storeEditFailure } from '../src/modules/Store/storeEditHelpers';

describe('Редактирование карточки магазина', () => {
    it('Сохраняет русское название, точное тело и версию открытой копии без служебных полей', () => {
        const skill: ISkillFile = {
            path: 'common/rag-index-monitor', body: '# Исходник\n',
            meta: { name: 'rag-index-monitor', slug: 'rag-index-monitor', scope: 'common', projectId: 'private-project', description: 'Раньше', mcp: ['rag'], plugins: [], tags: [], version: 7, owner: 'admin', updatedAt: '2026-10-16', history: [] },
        };
        const body = '# Мониторинг\n\n  Не удаляй пробелы.\n';
        const result = skillEditPayload(skill, { name: '  Монитор индекса  ', description: '  Проверяет RAG  ', tags: 'RAG, мониторинг, RAG', body, config: '' });
        expect(result).toEqual({ name: 'Монитор индекса', body, expectedVersion: 7, meta: { description: 'Проверяет RAG', tags: ['RAG', 'мониторинг'] } });
        expect(skill.meta.version).toBe(7);
        expect(skill.meta.description).toBe('Раньше');
    });

    it('Удаляет только повторяющиеся и пустые теги, сохраняя порядок', () => {
        expect(editTags(' RAG, , индекс, RAG, поиск ')).toEqual(['RAG', 'индекс', 'поиск']);
        expect(() => editTags(Array.from({ length: 21 }, (_, index) => `Тег ${index}`).join(','))).toThrow('до 20 тегов');
        expect(editTags('м'.repeat(80), 128)).toEqual(['м'.repeat(80)]);
    });

    it('Сохраняет пути Windows и аргументы с пробелами отдельными строками', () => {
        const config = { transport: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Мои проекты\\index.js', '--name', 'Два слова'], env: { API_KEY: '{env:RAG_API_KEY}', MODE: 'local' } };
        expect(editMcpConfig(JSON.stringify(config))).toEqual(config);
    });

    it('Объясняет, почему строка args и нестроковое окружение недопустимы', () => {
        expect(() => editMcpConfig('{"transport":"stdio","command":"node","args":"one two"}')).toThrow('JSON-массивом строк');
        expect(() => editMcpConfig('{"transport":"stdio","command":"node","env":{"PORT":42}}')).toThrow('строковые значения');
    });

    it('Не публикует API-ключ или нестандартный заголовок обычным текстом', () => {
        expect(() => editMcpConfig('{"transport":"stdio","command":"node","env":{"API_KEY":"private-value"}}')).toThrow('{env:ИМЯ_ПЕРЕМЕННОЙ}');
        expect(() => editMcpConfig('{"transport":"remote","url":"https://example.com/mcp","headers":{"X-Custom":"private-value"}}')).toThrow('X-Custom');
        expect(editMcpConfig('{"transport":"remote","url":"https://example.com/mcp","headers":{"Authorization":"Bearer {env:MCP_TOKEN}"},"oauth":false}')).toMatchObject({ transport: 'remote', oauth: false });
    });
    it('Не позволяет скрыть literal секрет рядом с placeholder', () => {
        expect(() => editMcpConfig(JSON.stringify({transport:'stdio',command:'node',env:{API_KEY:'private-{env:KEY}'}}))).toThrow('замените секрет');
        expect(() => editMcpConfig(JSON.stringify({transport:'remote',url:'https://example.org/mcp',headers:{Authorization:'Bearer private {env:KEY}'}}))).toThrow('замените секрет');
        expect(editMcpConfig(JSON.stringify({transport:'remote',url:'https://example.org/mcp',headers:{Authorization:'Basic {env:KEY}'}}))).toHaveProperty('headers.Authorization','Basic {env:KEY}');
    });

    it('Отклоняет URL с паролем, токеном, фрагментом или неподдерживаемой схемой', () => {
        for (const url of ['https://user:password@example.com/mcp', 'https://example.com/mcp?api_key=secret', 'https://example.com/mcp#key', 'file:///tmp/mcp']) {
            expect(() => editMcpConfig(JSON.stringify({ transport: 'remote', url }))).toThrow('HTTP(S)');
        }
    });

    it('Не смешивает удалённое подключение с локальной командой и неизвестными полями', () => {
        expect(() => editMcpConfig('{"transport":"remote","url":"https://example.com/mcp","command":"node"}')).toThrow('без локальной команды');
        expect(() => editMcpConfig('{"transport":"stdio","command":"node","extra":true}')).toThrow('Поддерживаются поля');
        expect(() => editMcpConfig('[]')).toThrow('JSON-объектом');
    });

    it('Не принимает опасные ключи окружения и дубли заголовков с другим регистром', () => {
        expect(() => editMcpConfig('{"transport":"stdio","command":"node","env":{"__proto__":"oops"}}')).toThrow('проверьте имена');
        expect(() => editMcpConfig('{"transport":"remote","url":"https://example.com/mcp","headers":{"Accept":"application/json","accept":"text/plain"}}')).toThrow('проверьте имена');
    });

    it('Сохраняет объяснение конфликта версии и напоминает о несохранённых правках', () => {
        expect(storeEditFailure({ response: { status: 409, data: { message: 'Актуальная версия — 8.' } } }, 'Ошибка')).toEqual({ status: 409, message: 'Актуальная версия — 8. Ваши правки остались в форме.' });
    });

    it('Не выдаёт отказ зависимости за параллельное изменение версии', () => {
        const detail = 'Закреплённая зависимость недоступна или изменилась: ai-plug-legacy.';
        const failure = storeEditFailure({ response: { status: 409, data: { message: detail } } }, 'Ошибка');
        expect(failure.message).toBe(detail + ' Ваши правки остались в форме.');
        expect(failure.message).not.toContain('Версия изменилась');
    });

    it('Показывает все серверные ошибки валидации и честную ошибку отсутствия связи', () => {
        expect(storeEditFailure({ response: { status: 400, data: { message: ['Заполните описание.', 'Проверьте теги.'] } } }, 'Ошибка').message).toBe('Заполните описание. Проверьте теги.');
        const error = Object.assign(new Error('Network Error'), { isAxiosError: true });
        expect(storeEditFailure(error, 'Нет связи, правки сохранены в форме.').message).toBe('Нет связи, правки сохранены в форме.');
    });
});
