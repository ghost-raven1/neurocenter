import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCard } from '../src/features/ModelCatalog/ModelCard';
import type { ICatalogModel, IModelHosting } from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({ hosting: { state: 'ready', message: 'Проверка пройдена', checkedAt: '2026-10-19T01:00:00Z' } as IModelHosting }));
vi.mock('../src/features/ModelCatalog/useModelHosting', () => ({ useModelHosting: () => ({
    hosting: ui.hosting, busy: ui.hosting.state === 'busy', loading: false, error: '', refresh: vi.fn(), operate: vi.fn(),
}) }));
const model: ICatalogModel = { id: 'model-a', name: 'Поиск по проекту', description: 'Локальная модель для базы знаний', capability: 'embedding', runtime: 'ollama', model: 'qwen3-embedding:4b', manifestSha256: null, dimension: 2560, source: 'builtin', revision: 1, createdAt: '2026-10-19', updatedAt: '2026-10-19' };
const render = (canHost = false, canAssign = false, assigned = true, projectSelected = true): string => renderToStaticMarkup(createElement(ModelCard, {
    model, canHost, canAssign, assigned, projectSelected, busy: false, onAssign: vi.fn(), onView: vi.fn(),
}));
beforeEach(() => { ui.hosting = { state: 'ready', message: 'Проверка пройдена', checkedAt: '2026-10-19T01:00:00Z' }; });

describe('Модели в общем и проектном каталоге', () => {
    it('Участник видит модель и статус без управления назначением и хостингом', () => {
        const html = render();
        expect(html).toContain('Доступна участникам проекта');
        expect(html).toContain('qwen3-embedding:4b');
        expect(html).toContain('Проверка пройдена');
        expect(html).not.toContain('Запустить');
        expect(html).not.toContain('Проверить модель');
        expect(html).not.toContain('Убрать из проекта');
    });
    it('Администратор проекта назначает модель, главный администратор управляет хостингом', () => {
        const projectAdmin = render(false, true, false);
        expect(projectAdmin).toContain('Добавить в проект');
        expect(projectAdmin).not.toContain('Выгрузить из памяти');
        const main = render(true, true, true);
        expect(main).toContain('Убрать из проекта');
        expect(main).toContain('Запустить');
        expect(main).toContain('Проверить модель');
        expect(main).toContain('Выгрузить из памяти');
    });
    it('Без выбранного проекта показывает следующий шаг вместо неработающей установки', () => {
        expect(render(false, false, false, false)).toContain('Выберите проект для добавления модели');
    });
    it('Выполняющаяся загрузка показывает сообщение и прогресс', () => {
        ui.hosting = { state: 'busy', message: 'Загрузка весов', checkedAt: null, operation: { id: 'op-a', action: 'start', state: 'running', stage: 'download', message: 'Получено 25%', progress: 25, startedAt: '2026-10-19', finishedAt: null } };
        const html = render(true);
        expect(html).toContain('Получено 25%');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('25%');
        expect(html).toContain('disabled');
    });
    it('Сохранённая модель не скрывает причину последнего неудачного запуска', () => {
        ui.hosting = { state: 'stopped', message: 'Веса сохранены', checkedAt: null, operation: { id: 'op-a', action: 'start', state: 'failed', stage: 'failed', message: 'Недостаточно свободного места', progress: null, startedAt: '2026-10-19', finishedAt: '2026-10-19' } };
        const html = render(true);
        expect(html).toContain('Недостаточно свободного места');
        expect(html).toContain('Запустить');
    });
});
