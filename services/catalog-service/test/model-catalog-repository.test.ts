import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ModelsRepository, setupModelsSchema } from '../src/models/models.repository';

const descriptor = { description: 'Модель проекта', capability: 'embedding', runtime: 'ollama', model: 'example:1', dimension: 3, manifestSha256: null, source: 'custom' };
const row = { id: 'model-example', name: 'Пример', descriptor, revision: 1, created_at: new Date('2026-10-19T00:00:00Z'), updated_at: '2026-10-19T00:00:00Z' };
const link = { project_id: 'prj-example', model_id: row.id, added_by: 'first@example.invalid', added_at: '2026-10-19T00:00:00Z' };
const actor = 'operator@example.invalid';
const query = vi.fn();
const release = vi.fn();
const pool = { query, connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
const events = () => query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO security_events'));

describe('Транзакционный каталог моделей', () => {
    let repository: ModelsRepository;
    beforeEach(() => {
        vi.clearAllMocks();
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            if (sql.includes('pg_try_advisory_xact_lock')) { return { rows: [{ locked: true }] }; }
            if (sql.startsWith('SELECT * FROM model_catalog')) { return { rows: [row] }; }
            if (sql.startsWith('SELECT id FROM projects') || sql.startsWith('SELECT id FROM model_catalog WHERE id=')) { return { rows: [{ id: row.id }] }; }
            if (sql.startsWith('INSERT INTO model_catalog_versions')) { return { rows: [] }; }
            if (sql.startsWith('INSERT INTO model_catalog')) { return { rows: [{ ...row, id: values![0], name: values![1], descriptor: JSON.parse(String(values![2])) }] }; }
            if (sql.startsWith('UPDATE model_catalog SET archived_at')) { return { rows: [{ ...row, archived_at: new Date(), revision: 2 }] }; }
            if (sql.startsWith('UPDATE model_catalog')) { return { rows: [{ ...row, name: values![1], descriptor: JSON.parse(String(values![2])), revision: 2 }] }; }
            if (sql.startsWith('INSERT INTO project_models') || sql.startsWith('DELETE FROM project_models')) { return { rows: [link] }; }
            return { rows: [] };
        });
        repository = new ModelsRepository(pool);
    });

    it('Создание фиксирует карточку и исполнителя до COMMIT', async () => {
        const saved = await repository.create({ name: row.name, capability: 'embedding', model: 'example:1', dimension: 3 }, actor);
        expect(saved).toMatchObject({ id: expect.stringMatching(/^model-/), source: 'custom', manifestSha256: null, dimension: 3, createdAt: '2026-10-19T00:00:00.000Z' });
        const payload = events()[0][1];
        expect(payload.slice(1, 4)).toEqual([actor, 'model.create', saved.id]);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Редактирование блокирует карточку и увеличивает ревизию, сохраняя техническую модель', async () => {
        const saved = await repository.update(row.id, { expectedRevision: 1, name: 'Новое имя' }, actor);
        expect(saved).toMatchObject({ name: 'Новое имя', revision: 2, model: 'example:1', dimension: 3 });
        expect(query.mock.calls.some(([sql]) => sql.endsWith('FOR UPDATE'))).toBe(true);
        expect(events()[0][1].slice(1, 3)).toEqual([actor, 'model.update']);
    });

    it('Конфликт ревизии не затирает карточку и не создаёт аудит', async () => {
        await expect(repository.update(row.id, { expectedRevision: 2, name: 'Чужой черновик' }, actor)).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
        expect(events()).toHaveLength(0);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Повторное сохранение не меняет ревизию и историю', async () => {
        await repository.update(row.id, { expectedRevision: 1, name: row.name, description: descriptor.description }, actor);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
        expect(events()).toHaveLength(0);
    });

    it('Название защищено от дублей независимо от регистра', async () => {
        const previous = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values?: unknown[]) => sql.startsWith('SELECT id FROM model_catalog WHERE lower(name)') ? { rows: [{ id: 'model-other' }] } : previous(sql, values));
        await expect(repository.create({ name: row.name.toUpperCase(), capability: 'chat', model: 'example:1' }, actor)).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO model_catalog'))).toBe(false);
        expect(query.mock.calls.some(([sql]) => sql.includes("'neurocenter:model-name:'||lower($1)"))).toBe(true);
    });

    it.each(['create', 'update', 'assign', 'unassign', 'remove'])('Сбой аудита откатывает %s', async action => {
        const previous = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Журнал недоступен'); }
            return previous(sql, values);
        });
        const result = action === 'create' ? repository.create({ name: row.name, capability: 'chat', model: 'example:1' }, actor)
            : action === 'update' ? repository.update(row.id, { expectedRevision: 1, description: 'Изменено' }, actor)
            : action === 'assign' ? repository.assign('prj-example', row.id, actor)
            : action === 'unassign' ? repository.unassign('prj-example', row.id, actor)
            : repository.remove(row.id, { expectedRevision: 1 }, actor);
        await expect(result).rejects.toThrow('Журнал недоступен');
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    });

    it('Назначение проверяет проект и модель под блокировками перед созданием ссылки', async () => {
        await repository.assign('prj-example', row.id, actor);
        const locks = query.mock.calls.filter(([sql]) => /FOR (KEY )?SHARE/.test(sql)).map(([sql]) => sql);
        expect(locks).toHaveLength(2);
        expect(events()[0][1].slice(1, 4)).toEqual([actor, 'project.model.add', `prj-example · ${row.id}`]);
        const state = JSON.parse(events()[0][1][5]);
        expect(state).toMatchObject({ projectId: 'prj-example', modelId: row.id, addedBy: link.added_by });
    });

    it.each(['projects', 'model_catalog'])('Удалённая запись %s не оставляет ложного назначения', async table => {
        const previous = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values?: unknown[]) => sql.startsWith(`SELECT id FROM ${table} WHERE id=`) ? { rows: [] } : previous(sql, values));
        await expect(repository.assign('prj-example', row.id, actor)).rejects.toMatchObject({ status: 404 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO project_models'))).toBe(false);
        expect(events()).toHaveLength(0);
    });

    it('Повтор назначения и отсутствие удаляемой ссылки не создают событий', async () => {
        const previous = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values?: unknown[]) => /^(INSERT INTO|DELETE FROM) project_models/.test(sql) ? { rows: [] } : previous(sql, values));
        await repository.assign('prj-example', row.id, actor);
        expect(await repository.unassign('prj-example', row.id, actor)).toBe(false);
        expect(events()).toHaveLength(0);
    });

    it('Архивирование сохраняет прежнюю карточку, immutable snapshot и аудит без физического удаления', async () => {
        await repository.remove(row.id, { expectedRevision: 1 }, actor);
        expect(events()[0][1].slice(1, 4)).toEqual([actor, 'model.archive', row.id]);
        expect(JSON.parse(events()[0][1][4])).toMatchObject({ id: row.id, revision: 1 });
        expect(JSON.parse(events()[0][1][5])).toMatchObject({ id: row.id, revision: 2, removedProjectRefs: false });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM model_catalog'))).toBe(false);
        expect(query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO model_catalog_versions'))).toHaveLength(2);
    });

    it.each(['busy', 'assigned', 'stale'])('Удаление отклоняется без потери данных: %s', async scenario => {
        const previous = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            if (scenario === 'busy' && sql.includes('pg_try_advisory_xact_lock')) { return { rows: [{ locked: false }] }; }
            if (scenario === 'assigned' && sql.startsWith('SELECT 1 FROM project_models')) { return { rows: [{}] }; }
            return previous(sql, values);
        });
        await expect(repository.remove(row.id, { expectedRevision: scenario === 'stale' ? 2 : 1 }, actor)).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM model_catalog'))).toBe(false);
        expect(events()).toHaveLength(0);
    });

    it('Схема создаёт отдельные назначения моделей и сохраняет существующие карточки', async () => {
        await setupModelsSchema(pool);
        const schema = query.mock.calls.find(([sql]) => sql.startsWith('CREATE TABLE IF NOT EXISTS model_catalog'))![0];
        expect(schema).toContain('REFERENCES projects(id) ON DELETE CASCADE');
        expect(schema).toContain('REFERENCES model_catalog(id) ON DELETE RESTRICT');
        expect(schema).toContain('model_catalog(lower(name))');
        expect(query.mock.calls.some(([sql]) => /(?:INSERT INTO|UPDATE|DELETE FROM) model_catalog(?:\s|\()/.test(sql))).toBe(false);
        expect(query.mock.calls.some(([sql]) => sql.includes('project_assets'))).toBe(false);
    });
});
