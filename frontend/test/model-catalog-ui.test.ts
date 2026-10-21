import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCard } from '../src/features/ModelCatalog/ModelCard';
import { ModelHosting } from '../src/features/ModelCatalog/ModelHosting';
import type { ICatalogModel, IModelHosting } from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({ hosting: { state: 'ready', message: 'Проверка пройдена', checkedAt: '2026-10-19T01:00:00Z' } as IModelHosting }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: 'fixture', captureOwner: () => () => true }) }));
vi.mock('../src/features/ModelCatalog/useModelHosting', () => ({ useModelHosting: () => ({
    hosting: ui.hosting, busy: ui.hosting.state === 'busy', loading: false, error: '', refresh: vi.fn(), operate: vi.fn(),
}) }));
const model: ICatalogModel = { id: 'model-a', name: 'Поиск по проекту', description: 'Локальная модель для базы знаний', capability: 'embedding', runtime: 'ollama', model: 'qwen3-embedding:4b', manifestSha256: null, dimension: 2560, source: 'builtin', revision: 1, createdAt: '2026-10-19', updatedAt: '2026-10-19' };
const render = (canHost = false, canAssign = false, assigned = true, projectSelected = true): string => renderToStaticMarkup(createElement(ModelCard, {
    model, canHost, canAssign, assigned, projectSelected, busy: false, onAssign: vi.fn(), onView: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn(),
}));
beforeEach(() => { ui.hosting = { state: 'ready', message: 'Проверка пройдена', checkedAt: '2026-10-19T01:00:00Z' }; });

describe('Модели в общем и проектном каталоге', () => {
    it.each(['ready', 'stopped', 'unavailable', 'error'] as const)('Удалённая модель в состоянии %s всегда открывает настройки API из карточки', state => {
        ui.hosting = { state, message: '', checkedAt: null };
        const props = { model: { ...model, runtime: 'remote-openai' as const }, canHost: true, canAssign: false,
            assigned: false, projectSelected: false, busy: false, onAssign: vi.fn(), onView: vi.fn(), onConfigure: vi.fn() };
        const html = renderToStaticMarkup(createElement(ModelCard, props));
        expect(html).toContain('Настроить API модели Поиск по проекту');
        expect(html.match(/>Настроить API</g)).toHaveLength(1);
        for (const changed of [{ canHost: false }, { model: { ...props.model, archivedAt: '2026-10-21' } }, { model }]) {
            expect(renderToStaticMarkup(createElement(ModelCard, { ...props, ...changed }))).not.toContain('Настроить API модели');
        }
    });
    it('Назначенная проверенная embedding-модель предлагает подключение отдельно от удаления, с причиной блокировки',()=>{
        const verified={...model,manifestSha256:'a'.repeat(64)},props={model:verified,canHost:false,canAssign:true,assigned:true,projectSelected:true,busy:false,onAssign:vi.fn(),onView:vi.fn(),onConnect:vi.fn()};
        const html=renderToStaticMarkup(createElement(ModelCard,props));expect(html).toContain('Подключить модель');expect(html).toContain('Убрать из проекта');
        const blocked=renderToStaticMarkup(createElement(ModelCard,{...props,connectionUnavailableReason:'Сначала выберите установку OpenCodeRAG.'}));
        expect(blocked).toContain('Сначала выберите установку OpenCodeRAG.');expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*><span>Подключить модель<\/span><\/button>/);
        for(const changed of [{canAssign:false},{assigned:false},{projectSelected:false},{model},{model:{...verified,archivedAt:'2026-10-21'}}])expect(renderToStaticMarkup(createElement(ModelCard,{...props,...changed}))).not.toContain('Подключить модель');
    });
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
        expect(main).toContain('Изменить модель Поиск по проекту');
        expect(main).toContain('Убрать из каталога модель Поиск по проекту');
        expect(main).not.toContain('Выгрузить из памяти');
        expect(main).not.toContain('Проверить модель');
        expect(projectAdmin).not.toContain('Изменить модель Поиск по проекту');
        expect(projectAdmin).not.toContain('Убрать из каталога модель Поиск по проекту');
        const management = renderToStaticMarkup(createElement(ModelHosting, { model, canManage: true }));
        expect(management).toContain('Запустить'); expect(management).toContain('Проверить модель'); expect(management).toContain('Выгрузить из памяти');
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
    it('Недоступный сервер не предлагает запуск или готовое подключение в карточке', () => {
        ui.hosting = { state: 'unavailable', message: 'Нет соединения с runtime', checkedAt: null };
        const html = render(true);
        expect(html).toContain('Сервис недоступен'); expect(html).not.toContain('Запустить');
        expect(html).toContain('model-runtime__reason">Нет соединения с runtime');
        expect(html).toContain('Обновить статус модели Поиск по проекту');
    });
    it('Длинное имя, удалённый источник и архив не теряют семантику управления', () => {
        const html = renderToStaticMarkup(createElement(ModelCard, { model: { ...model, name: 'Удалённая модель с очень длинным именем', runtime: 'remote-openai', archivedAt: '2026-10-20' },
            assigned: true, projectSelected: true, canAssign: true, canHost: true, busy: false, onAssign: vi.fn(), onView: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn() }));
        expect(html).toContain('Удалённый API'); expect(html).toContain('Убрана из общего каталога');
        expect(html).not.toContain('Убрать из каталога модель'); expect(html).toContain('Убрать из проекта');
    });
});
