import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Pool } from 'pg';
import { FEATURE_FLAGS, defaultFeatureFlags } from '../../shared/feature-flags.cjs';
import { FlagsRepository } from '../src/flags/flags.repository';
import { featureFlagKey, featureFlagPatch } from '../src/flags/flag-validation';
import {migrateFeatureFlags} from '../src/database/migrations';

vi.mock('../src/database/migrations', () => ({migrateFeatureFlags: vi.fn()}));

const rows = () => FEATURE_FLAGS.map(item => ({ flag_key: item.key, overrides: {}, revision: '1', updated_at: new Date('2026-10-19T00:00:00Z'), updated_by: 'system:defaults' }));
const query = vi.fn(), release = vi.fn(), connect = vi.fn();
const pool = { query, connect } as unknown as Pool;
const actor = 'admin@example.invalid';

describe('Хранилище переключателей и аудит', () => {
    let repository: FlagsRepository;
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(migrateFeatureFlags).mockResolvedValue({ok:true,ready:true,applied:[1],pending:[]});
        connect.mockResolvedValue({ query, release });
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            if (sql.startsWith('SELECT * FROM feature_flags WHERE flag_key=ANY')) { return { rows: rows() }; }
            if (sql.startsWith('SELECT * FROM feature_flags WHERE flag_key=$1')) { return { rows: rows().filter(row => row.flag_key === values![0]) }; }
            if (sql.startsWith('UPDATE feature_flags')) { return { rows: [{ ...rows().find(row => row.flag_key === values![0])!, overrides: { enabled: values![1] }, revision: '2', updated_by: values![2] }] }; }
            return { rows: [] };
        });
        repository = new FlagsRepository(pool);
    });

    it('Применяет миграции перед defaults, а повтор не сбрасывает настройки', async () => {
        await repository.setup();
        expect(migrateFeatureFlags).toHaveBeenCalledExactlyOnceWith(pool);
        const statements = query.mock.calls.map(([sql]) => sql);
        expect(statements[0]).toBe('BEGIN');
        expect(statements[1]).toContain('neurocenter:catalog:migrations');
        expect(statements.filter(sql => sql.startsWith('INSERT INTO feature_flags'))).toEqual(Array(FEATURE_FLAGS.length).fill('INSERT INTO feature_flags(flag_key) VALUES($1) ON CONFLICT(flag_key) DO NOTHING'));
        expect(statements.at(-1)).toBe('COMMIT');
        expect(statements.some(sql => /CREATE|ALTER|DROP/.test(sql))).toBe(false);
    });

    it('Все зарегистрированные функции включены по умолчанию, переопределение действует отдельно', async () => {
        expect(await repository.evaluated()).toEqual(defaultFeatureFlags());
        query.mockResolvedValue({ rows: rows().map(row => row.flag_key === 'rag_sync' ? { ...row, overrides: { enabled: false } } : row) });
        expect(await repository.evaluated()).toEqual({ ...defaultFeatureFlags(), rag_sync: false });
        expect((await repository.list())[0]).toMatchObject({ revision: 1, updatedAt: '2026-10-19T00:00:00.000Z', updatedBy: 'system:defaults' });
    });

    it('Повреждённая или отсутствующая запись не превращается во включённую функцию', async () => {
        query.mockResolvedValueOnce({ rows: rows().slice(1) });
        await expect(repository.evaluated()).rejects.toThrow('отсутствует');
        query.mockResolvedValueOnce({ rows: rows().map(row => ({ ...row, overrides: { enabled: 'false' } })) });
        await expect(repository.evaluated()).rejects.toThrow('Некорректная');
    });

    it('Изменение и аудит фиксируются вместе после повторной проверки прав', async () => {
        const authorize = vi.fn(async () => { query.mock.calls.push(['ПРАВА ПОДТВЕРЖДЕНЫ']); return actor; });
        const saved = await repository.patch('model_hosting', { enabled: false, expectedRevision: 1 }, authorize);
        expect(saved).toMatchObject({ enabled: false, revision: 2, updatedBy: actor });
        const statements = query.mock.calls.map(([sql]) => sql);
        expect(statements.indexOf('ПРАВА ПОДТВЕРЖДЕНЫ')).toBeGreaterThan(statements.findIndex(sql => sql.endsWith('FOR UPDATE')));
        expect(statements.indexOf('ПРАВА ПОДТВЕРЖДЕНЫ')).toBeLessThan(statements.findIndex(sql => sql.startsWith('UPDATE feature_flags')));
        const event = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO security_events'))![1];
        expect(event.slice(1, 4)).toEqual([actor, 'feature_flag.update', 'model_hosting']);
        expect(JSON.parse(event[4])).toMatchObject({ key: 'model_hosting', enabled: true, revision: 1 });
        expect(JSON.parse(event[5])).toMatchObject({ key: 'model_hosting', enabled: false, revision: 2 });
        expect(statements.at(-1)).toBe('COMMIT');
        expect(release).toHaveBeenCalledOnce();
    });

    it('Устаревшая ревизия возвращает конфликт и не затирает выбор другой вкладки', async () => {
        await expect(repository.patch('model_hosting', { enabled: false, expectedRevision: 2 }, async () => actor)).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Повтор без изменения не увеличивает ревизию и не создаёт события', async () => {
        const authorize = vi.fn(async () => actor);
        expect(await repository.patch('model_hosting', { enabled: true, expectedRevision: 1 }, authorize)).toMatchObject({ revision: 1, enabled: true });
        expect(authorize).toHaveBeenCalledOnce();
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });

    it('Отзыв прав за время ожидания блокировки предотвращает сохранение', async () => {
        await expect(repository.patch('model_hosting', { enabled: false, expectedRevision: 1 }, async () => { throw new ForbiddenException('Права отозваны'); })).rejects.toMatchObject({ status: 403 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Сбой аудита откатывает переключатель и освобождает подключение', async () => {
        const previous = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values?: unknown[]) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Журнал недоступен'); }
            return previous(sql, values);
        });
        await expect(repository.patch('model_hosting', { enabled: false, expectedRevision: 1 }, async () => actor)).rejects.toThrow('Журнал недоступен');
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(release).toHaveBeenCalledOnce();
    });

    it.each(['normal','not-dispatched','ack-lost'] as const)('Ошибка после записи сохраняет primary error; ROLLBACK=%s определяет discard клиента',async rollback=>{
        const primary=Object.assign(new Error('Audit acknowledgment lost'),{code:'ECONNRESET'}),rollbackError=new Error('ROLLBACK acknowledgment lost'),executed:string[]=[];
        const previous=query.getMockImplementation()!;
        query.mockImplementation(async(sql:string,values?:unknown[])=>{
            if(sql==='ROLLBACK'&&rollback==='not-dispatched')throw rollbackError;
            const result=await previous(sql,values);
            executed.push(sql);
            if(sql==='ROLLBACK'&&rollback==='ack-lost')throw rollbackError;
            if(sql.startsWith('INSERT INTO security_events'))throw primary;
            return result;
        });
        await expect(repository.patch('model_hosting',{enabled:false,expectedRevision:1},async()=>actor)).rejects.toBe(primary);
        expect(query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE feature_flags'))).toHaveLength(1);
        expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO security_events'))).toHaveLength(1);
        expect(query.mock.calls.filter(([sql])=>sql==='ROLLBACK')).toHaveLength(1);
        expect(executed.filter(sql=>sql==='ROLLBACK')).toHaveLength(rollback==='not-dispatched'?0:1);
        expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
        if(rollback!=='normal')expect(release).toHaveBeenCalledExactlyOnceWith(true);
        else expect(release).toHaveBeenCalledExactlyOnceWith();
    });

    it.each(['normal','not-dispatched','ack-lost'] as const)('Defaults после ошибки записи сохраняют primary error и не возвращают неизвестную транзакцию: ROLLBACK=%s',async rollback=>{
        const primary=Object.assign(new Error('Default insert acknowledgment lost'),{code:'ECONNRESET'}),rollbackError=new Error('ROLLBACK acknowledgment lost'),executed:string[]=[];
        const previous=query.getMockImplementation()!;
        query.mockImplementation(async(sql:string,values?:unknown[])=>{
            if(sql==='ROLLBACK'&&rollback==='not-dispatched')throw rollbackError;
            const result=await previous(sql,values);
            executed.push(sql);
            if(sql==='ROLLBACK'&&rollback==='ack-lost')throw rollbackError;
            if(sql.startsWith('INSERT INTO feature_flags('))throw primary;
            return result;
        });
        await expect(repository.setup()).rejects.toBe(primary);
        expect(migrateFeatureFlags).toHaveBeenCalledExactlyOnceWith(pool);
        expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO feature_flags('))).toEqual([
            ['INSERT INTO feature_flags(flag_key) VALUES($1) ON CONFLICT(flag_key) DO NOTHING',[FEATURE_FLAGS[0].key]],
        ]);
        expect(query.mock.calls.filter(([sql])=>sql==='ROLLBACK')).toHaveLength(1);
        expect(executed.filter(sql=>sql==='ROLLBACK')).toHaveLength(rollback==='not-dispatched'?0:1);
        expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
        if(rollback!=='normal')expect(release).toHaveBeenCalledExactlyOnceWith(true);
        else expect(release).toHaveBeenCalledExactlyOnceWith();
    });

    it('Ошибка схемы не фиксирует частично подготовленное состояние', async () => {
        vi.mocked(migrateFeatureFlags).mockRejectedValueOnce(new Error('БД недоступна'));
        await expect(repository.setup()).rejects.toThrow('БД недоступна');
        expect(connect).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
    });

    it.each([null, [], {}, { enabled: 1, expectedRevision: 1 }, { enabled: false }, { enabled: false, expectedRevision: 0 },
        { enabled: false, expectedRevision: 1.5 }, { enabled: false, expectedRevision: '1' }, { enabled: false, expectedRevision: 1, targeting: {} },
        { enabled: false, expectedRevision: 1, actor: 'forged@example.invalid' }])('Некорректные изменения отклоняются до БД: %j', body => {
        expect(() => featureFlagPatch(body)).toThrow();
        expect(connect).not.toHaveBeenCalled();
    });

    it('Неизвестный флаг не создаётся через URL', async () => {
        expect(() => featureFlagKey('custom')).toThrow('не зарегистрирован');
        await expect(repository.patch('custom', { enabled: true, expectedRevision: 1 }, async () => actor)).rejects.toMatchObject({ status: 404 });
        expect(connect).not.toHaveBeenCalled();
    });
});
