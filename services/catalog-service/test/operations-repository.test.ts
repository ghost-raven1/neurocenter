import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogDb } from '../src/catalog/catalog-db';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/database/pool', () => ({ createPool: () => ({ query }) }));

const operationRow = {
    operation_id: 'op-test',
    type: 'SYNC',
    project_id: 'prj-one',
    resource_type: 'project',
    resource_id: 'prj-one',
    actor: 'user@example.test',
    state: 'RUNNING',
    percent: 20,
    bytes_done: '4096',
    bytes_total: '16384',
    started_at: '2026-10-18T05:00:00.000Z',
    finished_at: null,
    error: null,
    log: [{ at: '2026-10-18T05:00:00.000Z', level: 'INFO', message: 'Начата синхронизация' }],
    retries: 2,
    created_at: '2026-10-18T05:00:00.000Z',
};

describe('Контракт хранилища операций', () => {
    let db: CatalogDb;

    beforeEach(() => {
        query.mockReset().mockResolvedValue({ rows: [] });
        db = new CatalogDb('postgres://unused');
    });
    afterEach(() => vi.useRealTimers());

    it('Без области доступа сохраняет общий список главного администратора', async () => {
        query.mockResolvedValueOnce({ rows: [{ n: 25, active: 8, active_percent: 32.5, running: 3, queued: 5 }] }).mockResolvedValueOnce({ rows: [operationRow] });

        const page = await db.listOperations(3, 10);

        expect(query.mock.calls[0]).toEqual([expect.not.stringContaining('WHERE project_id'), []]);
        expect(query.mock.calls[1]).toEqual([expect.stringContaining('LIMIT $1 OFFSET $2'), [10, 20]]);
        expect(page).toMatchObject({ page: 3, size: 10, total: 25, activeCount: 8,
            activeProgress: { percent: 32.5, running: 3, queued: 5 } });
        expect(page.items[0]).toMatchObject({ bytesDone: 4096, bytesTotal: 16384 });
        expect(page.items[0]).not.toHaveProperty('log');
    });

    it('Пустой набор разрешённых проектов остаётся ограничением, а не общим доступом', async () => {
        query.mockResolvedValueOnce({ rows: [{ n: 0, active: 0, active_percent: 0, running: 0, queued: 0 }] });

        await db.listOperations(1, 20, []);

        expect(query.mock.calls[0]).toEqual([expect.stringContaining('WHERE project_id = ANY($1::text[])'), [[]]]);
        expect(query.mock.calls[1][1]).toEqual([[], 20, 0]);
        expect(query.mock.calls[0][0]).not.toContain(' OR actor=');
    });

    it('Личный мост без проекта добавляется к разрешённым проектам внутри границы состояния', async () => {
        query.mockResolvedValueOnce({ rows: [{ n: 1, active: 1, active_percent: 20, running: 1, queued: 0 }] });
        const actor = "user' OR true --";

        await db.listOperations(2, 5, undefined, 'RUNNING', {projectIds:['prj-one', 'Имя проекта'], actor});

        for (const [sql] of query.mock.calls) {
            expect(sql).toContain("WHERE (project_id = ANY($1::text[]) OR (project_id IS NULL AND resource_type='bridge' AND actor=$2)) AND state = $3");
            expect(sql).not.toContain(actor);
        }
        expect(query.mock.calls[0][1]).toEqual([['prj-one', 'Имя проекта'], actor, 'RUNNING']);
        expect(query.mock.calls[1][1]).toEqual([['prj-one', 'Имя проекта'], actor, 'RUNNING', 5, 5]);
    });

    it('Без проектов пользователь видит только собственный мост без проекта, а не платформенные операции', async () => {
        query.mockResolvedValueOnce({ rows: [{ n: 1, active: 0, active_percent: 0, running: 0, queued: 0 }] });

        await db.listOperations(1, 20, undefined, undefined, {projectIds:[],actor:'user@example.test'});

        expect(query.mock.calls[0]).toEqual([
            expect.stringContaining("WHERE (project_id = ANY($1::text[]) OR (project_id IS NULL AND resource_type='bridge' AND actor=$2))"),
            [[], 'user@example.test'],
        ]);
    });

    it('Фильтр projectId не заменяет область доступа и не открывает чужой проект', async () => {
        query.mockResolvedValueOnce({rows:[{n:0,active:0,active_percent:0,running:0,queued:0}]});
        await db.listOperations(1,20,['prj-foreign'],'RUNNING',{projectIds:['prj-own'],actor:'owner@example.test'});
        expect(query.mock.calls[0]).toEqual([
            expect.stringContaining("WHERE project_id = ANY($1::text[]) AND (project_id = ANY($2::text[]) OR (project_id IS NULL AND resource_type='bridge' AND actor=$3)) AND state = $4"),
            [['prj-foreign'],['prj-own'],'owner@example.test','RUNNING'],
        ]);
    });

    it('Считает активные операции в выбранном состоянии без ограничения размером страницы', async () => {
        query.mockResolvedValueOnce({ rows: [{ n: 40, active: 40, active_percent: 75, running: 40, queued: 0 }] });

        const page = await db.listOperations(4, 5, ['prj-one'], 'RUNNING');

        expect(page.activeCount).toBe(40);
        expect(page.activeProgress).toEqual({ percent: 75, running: 40, queued: 0 });
        const [countSql, countParams] = query.mock.calls[0];
        expect(countSql).toContain("FILTER (WHERE state IN ('QUEUED','RUNNING'))");
        expect(countSql).toContain('WHERE project_id = ANY($1::text[]) AND state = $2');
        expect(countSql).not.toContain('LIMIT');
        expect(countParams).toEqual([['prj-one'], 'RUNNING']);
    });

    it('Сводка ограничивает процент каждой активной операции и исключает завершённые записи', async () => {
        query.mockResolvedValueOnce({ rows: [{ n: 100, active: 3, active_percent: 50, running: 2, queued: 1 }] });

        const page = await db.listOperations(1, 1, ['prj-one']);

        expect(page.activeProgress).toEqual({ percent: 50, running: 2, queued: 1 });
        const sql = query.mock.calls[0][0];
        expect(sql).toContain("avg(LEAST(100, GREATEST(0, percent))) FILTER (WHERE state IN ('QUEUED','RUNNING'))");
        expect(sql).toContain("count(*) FILTER (WHERE state = 'RUNNING')::int AS running");
        expect(sql).toContain("count(*) FILTER (WHERE state = 'QUEUED')::int AS queued");
        expect(sql).not.toContain('bytes_');
    });

    it('Пустая сводка возвращает числовой ноль и не создаёт вымышленные активные операции', async () => {
        query.mockResolvedValueOnce({ rows: [{ n: '4', active: '0', active_percent: '0', running: '0', queued: '0' }] });

        const page = await db.listOperations(1, 20, ['prj-one'], 'FAILED');

        expect(page.activeCount).toBe(0);
        expect(page.activeProgress).toEqual({ percent: 0, running: 0, queued: 0 });
        expect(query.mock.calls[0][0]).toContain('), 0)::float8 AS active_percent');
    });

    it.each([operationRow.log, JSON.stringify(operationRow.log), null])('Читает журнал JSONB и старый строковый формат: %j', async log => {
        query.mockResolvedValueOnce({ rows: [{ ...operationRow, log }] });

        const result = await db.getOperation('op-test');

        expect(query).toHaveBeenCalledWith('SELECT * FROM operations WHERE operation_id = $1', ['op-test']);
        expect(result).toMatchObject({ operationId: 'op-test', bytesDone: 4096, retries: 2, log: log === null ? [] : operationRow.log });
    });

    it('Отсутствующая операция не превращается в пустую карточку при чтении и изменении', async () => {
        expect(await db.getOperation('missing')).toBeNull();
        expect(await db.setOperationState('missing', 'CANCELLED')).toBeNull();
    });

    it('Detail проверяет ту же область SQL до чтения журнала и не доверяет исполнителю отозванного проекта', async () => {
        const scope={projectIds:[],actor:'user@example.test'};
        expect(await db.getOperation('op-foreign',scope)).toBeNull();
        expect(query).toHaveBeenCalledWith(
            "SELECT * FROM operations WHERE operation_id = $1 AND (project_id = ANY($2::text[]) OR (project_id IS NULL AND resource_type='bridge' AND actor=$3))",
            ['op-foreign',[],scope.actor],
        );
    });

    it('Повтор сохраняет атомарное очищение ошибки, времён и дополнение журнала', async () => {
        query.mockResolvedValueOnce({ rows: [{ ...operationRow, retries: 3 }] });

        const result = await db.setOperationState('op-test', 'RUNNING', {
            percent: 0,
            clearError: true,
            resetTimes: true,
            logMessage: 'Повтор по запросу пользователя',
        });

        expect(query.mock.calls[0][1]).toEqual(['op-test', 'RUNNING', 0, null, null, true, true, 'Повтор по запросу пользователя']);
        const sql = query.mock.calls[0][0];
        expect(sql).toContain('error = CASE WHEN $6::boolean THEN NULL');
        expect(sql).toContain('started_at = CASE WHEN $7::boolean THEN now()');
        expect(sql).toContain('WHEN $7::boolean THEN NULL');
        expect(sql).toContain("COALESCE(log, '[]'::jsonb) || jsonb_build_array");
        expect(sql).toContain("retries = CASE WHEN $2 = 'RUNNING' THEN retries + 1 ELSE retries END");
        expect(result?.retries).toBe(3);
    });

    it('Смена состояния без дополнительных полей сохраняет существующий прогресс и журнал', async () => {
        await db.setOperationState('op-test', 'CANCELLED');

        expect(query.mock.calls[0][1]).toEqual(['op-test', 'CANCELLED', null, null, null, false, false, null]);
        expect(query.mock.calls[0][0]).toContain('percent = COALESCE($3, percent)');
        expect(query.mock.calls[0][0]).toContain('WHEN $8::text IS NULL THEN log');
    });

    it.each([
        { state: 'SUCCEEDED', error: null, level: 'INFO', active: false },
        { state: 'CANCELLED', error: null, level: 'WARN', active: false },
        { state: 'FAILED', error: 'Нет места', level: 'ERROR', active: false },
        { state: 'RUNNING', error: null, level: 'INFO', active: true },
        { state: 'QUEUED', error: null, level: 'INFO', active: true },
    ] as const)('Создание $state сохраняет итоговое время и уровень журнала', async ({ state, error, level, active }) => {
        const now = '2026-10-18T05:00:00.000Z';
        vi.useFakeTimers().setSystemTime(new Date(now));
        query.mockResolvedValueOnce({ rows: [{ ...operationRow, state, error }] });

        await db.createOperation({ type: 'SYNC', state, error, projectId: 'prj-one', resourceType: 'project', resourceId: 'prj-one', actor: ' user@example.test ', percent: 0, message: 'Синхронизация' });

        const params = query.mock.calls[0][1];
        expect(params.slice(1, 11)).toEqual(['SYNC', 'prj-one', 'project', 'prj-one', 'user@example.test', state, 0, now, active ? null : now, error]);
        expect(JSON.parse(params[11])).toEqual([{ at: now, level, message: 'Синхронизация' }]);
        expect(query.mock.calls[0][0]).toContain('RETURNING *');
    });

    it('Создание без необязательных полей сохраняет прежние значения по умолчанию', async () => {
        query.mockResolvedValueOnce({ rows: [operationRow] });

        await db.createOperation({ type: 'SYNC', actor: ' ' });

        expect(query.mock.calls[0][1].slice(1, 8)).toEqual(['SYNC', null, null, null, 'admin', 'SUCCEEDED', 100]);
        expect(JSON.parse(query.mock.calls[0][1][11])[0].message).toBe('SYNC');
    });
});
