import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IStoreApp } from '../src/modules/Store/AppCard';
import type { ISkillFile } from '../src/core/api/interfaces';
import { formatDetailDate, hasConfigSecrets, instructionUrl, keepDetailAfterRefreshError, loadStoreDetail, previewConfig, sortSkillHistory } from '../src/modules/Store/storeDetails';
import StoreInstruction from '../src/modules/Store/StoreInstruction';

const app: IStoreApp = { id: 'ops/rag-index-monitor', path: 'ops/rag-index-monitor', name: 'rag-index-monitor', kind: 'skill', description: '', version: 1, tags: [], origin: '' };

describe('Подробности скилла в магазине', () => {
    it('Читает скилл по полному пути и сохраняет метаданные и инструкцию', async () => {
        const skill = { path: app.path, body: '# Инструкция', meta: { scope: 'common', owner: 'platform', version: 2, history: [] } } as ISkillFile;
        const api = { getSkill: vi.fn().mockResolvedValue(skill), getAiPlugin: vi.fn() };

        expect(await loadStoreDetail(api, app)).toEqual({ kind: 'skill', skill });
        expect(api.getSkill).toHaveBeenCalledWith('ops/rag-index-monitor');
        expect(api.getAiPlugin).not.toHaveBeenCalled();
    });

    it('Показывает ошибку вместо бесконечной загрузки при отсутствии пути', async () => {
        const api = { getSkill: vi.fn(), getAiPlugin: vi.fn() };
        await expect(loadStoreDetail(api, { ...app, path: undefined })).rejects.toThrow('не указан путь');
        expect(api.getSkill).not.toHaveBeenCalled();
    });

    it('Не подменяет ошибку сервера пустой инструкцией', async () => {
        const api = { getSkill: vi.fn().mockRejectedValue(new Error('Нет доступа')), getAiPlugin: vi.fn() };
        await expect(loadStoreDetail(api, app)).rejects.toThrow('Нет доступа');
    });

    it('Сохраняет прочитанный текст при сбое сети, но скрывает при отзыве доступа и удалении', () => {
        expect(keepDetailAfterRefreshError(new Error('Сеть недоступна'))).toBe(true);
        expect(keepDetailAfterRefreshError({ isAxiosError: true, response: { status: 503 } })).toBe(true);
        for (const status of [401, 403, 404, 410]) {
            expect(keepDetailAfterRefreshError({ isAxiosError: true, response: { status } })).toBe(false);
        }
    });

    it('Загружает текущий MCP отдельно от истории его версий', async () => {
        const plugin = { id: 'monitor', version: 4 };
        const api = { getSkill: vi.fn(), getAiPlugin: vi.fn().mockResolvedValue(plugin) };
        expect(await loadStoreDetail(api, { ...app, id: 'monitor', kind: 'mcp' })).toEqual({ kind: 'bundle', plugin });
        expect(api.getAiPlugin).toHaveBeenCalledWith('monitor');
    });

    it('Не выводит некорректные даты', () => {
        expect(formatDetailDate()).toBe('Не указана');
        expect(formatDetailDate('не дата')).toBe('Не указана');
        expect(formatDetailDate('2026-10-14T00:00:00Z')).toContain('2026');
    });

    it('Сортирует версии без изменения исходной истории', () => {
        const history = [{ version: 1, at: '', author: 'Алексей' }, { version: 3, at: '', author: 'Мария' }];
        expect(sortSkillHistory(history).map(item => item.version)).toEqual([3, 1]);
        expect(history.map(item => item.version)).toEqual([1, 3]);
    });

    it('Не раскрывает значения окружения в предпросмотре и не изменяет конфигурацию', () => {
        const config = { command: 'node', args: ['index.js'], env: { API_KEY: 'секрет', EMPTY: '' }, headers: {Authorization: 'Bearer секрет-заголовка'} };
        const preview = previewConfig(config);
        expect(preview).not.toContain('секрет');
        expect(JSON.parse(preview)).toEqual({ command: 'node', args: ['index.js'], env: { API_KEY: '••••••••', EMPTY: '••••••••' }, headers: {Authorization: '••••••••'} });
        expect(config.env.API_KEY).toBe('секрет');
        expect(previewConfig(null)).toBe('');
        expect(hasConfigSecrets(config)).toBe(true);
        expect(hasConfigSecrets({ env: {}, headers: {} })).toBe(false);
    });

    it('Разрешает адреса документов и блокирует команды и неподключённые локальные ресурсы', () => {
        expect(instructionUrl('https://example.org/docs?q=1#part')).toBe('https://example.org/docs?q=1#part');
        expect(instructionUrl('mailto:team@example.org')).toBe('mailto:team@example.org');
        for (const url of ['javascript:alert(1)', 'data:text/html,test', '//example.org', '../scripts/run.sh', 'file:///tmp/test', 'https://user:pass@example.org', 'https:\\example.org', '\nhttps://example.org']) {
            expect(instructionUrl(url)).toBeUndefined();
        }
    });

    it('Читает всю инструкцию с заголовками, списком и кодом', () => {
        const html = renderToStaticMarkup(createElement(StoreInstruction, { body: '# RAG index monitor\n\nОписание.\n\n## Эндпоинты\n- `GET /api/rag/projects`\n- `GET /api/rag/summary`\n\nПоследняя строка инструкции.' }));
        expect(html).toContain('<h1>RAG index monitor</h1>');
        expect(html).toContain('<h2>Эндпоинты</h2>');
        expect(html).toContain('<code>GET /api/rag/projects</code>');
        expect(html).toContain('Последняя строка инструкции.');
    });

    it('Не выполняет HTML, не загружает картинки и не делает опасные ссылки активными', () => {
        const html = renderToStaticMarkup(createElement(StoreInstruction, { body: '<script>alert(1)</script>\n\n[Команда](javascript:alert) [Документация](https://example.org) [Файл](./guide.md) ![Схема](https://example.org/pixel.png)' }));
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('href="javascript:');
        expect(html).not.toContain('href="./guide.md"');
        expect(html).toContain('href="https://example.org" target="_blank" rel="noopener noreferrer"');
        expect(html).toContain('Схема');
        expect(html).toContain('см. исходник');
    });
});
