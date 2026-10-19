import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {setupSecurityEvents} from '../src/access/security-events';

describe('Общая подготовка журнала безопасности',()=>{
    it('Создаёт таблицу и индекс под транзакционной блокировкой одного соединения',async()=>{
        const query=vi.fn().mockResolvedValue({rows:[]}),release=vi.fn();
        const connect=vi.fn().mockResolvedValue({query,release});
        await setupSecurityEvents({connect} as unknown as Pool);
        expect(connect).toHaveBeenCalledOnce();
        expect(query.mock.calls[0]).toEqual(['BEGIN']);
        expect(query.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
        expect(query.mock.calls[1][0]).toContain('neurocenter:security-events-schema');
        expect(query.mock.calls[2][0]).toContain('CREATE TABLE IF NOT EXISTS security_events');
        expect(query.mock.calls[2][0]).toContain('CREATE INDEX IF NOT EXISTS security_events_created');
        expect(query.mock.calls[3]).toEqual(['COMMIT']);
        expect(release).toHaveBeenCalledOnce();
    });
    it('Сохраняет исходную ошибку DDL, откатывает и освобождает соединение',async()=>{
        const failure=new Error('Собственный отказ DDL');
        const query=vi.fn(async(sql:string)=>{
            if(sql.includes('CREATE TABLE')){throw failure;}
            if(sql==='ROLLBACK'){throw new Error('Соединение уже закрыто');}
            return {rows:[]};
        }),release=vi.fn();
        await expect(setupSecurityEvents({connect:async()=>({query,release})} as unknown as Pool)).rejects.toBe(failure);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
        expect(release).toHaveBeenCalledOnce();
    });
    it('Не скрывает отказ получения соединения',async()=>{
        const failure=new Error('Собственный отказ подключения');
        await expect(setupSecurityEvents({connect:async()=>{throw failure;}} as unknown as Pool)).rejects.toBe(failure);
    });
});
