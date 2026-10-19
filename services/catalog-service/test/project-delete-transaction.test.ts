import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CatalogDb} from '../src/catalog/catalog-db';

const adapter=vi.hoisted(()=>({pool:undefined as unknown}));
vi.mock('../src/database/pool',()=>({createPool:()=>adapter.pool}));

const project={id:'prj-delete',name:'Проект «Проверка»',state:'ACTIVE',retention:30,quota:null};

/** Изолированный адаптер сохраняет изменения только после COMMIT; SQL и отказы остаются наблюдаемыми. */
function fixture() {
    let present=true,failAudit=false,failDelete=false,lock=Promise.resolve();
    const operations:unknown[][]=[],calls:Array<[string,unknown[]|undefined]>=[],release=vi.fn();
    interface Transaction {deleted:boolean;operations:unknown[][];unlock?:()=>void}
    const query=async(sql:string,values?:unknown[],transaction?:Transaction)=>{
        calls.push([sql,values]);
        if(sql==='BEGIN')return {rows:[]};
        if(sql==='COMMIT') {
            if(transaction?.deleted)present=false;
            operations.push(...transaction?.operations??[]);transaction?.unlock?.();return {rows:[]};
        }
        if(sql==='ROLLBACK'){transaction?.unlock?.();return {rows:[]};}
        if(sql.startsWith('SELECT')&&sql.includes('FROM projects')) {
            if(transaction&&sql.includes('FOR UPDATE')) {
                const previous=lock;lock=new Promise(resolve=>{transaction.unlock=resolve;});await previous;
            }
            const matches=values?.[0]===project.id||values?.[0]===project.name;
            return {rows:present&&!transaction?.deleted&&matches?[project]:[]};
        }
        if(sql.startsWith('DELETE FROM projects')) {
            if(failDelete)throw new Error('Удаление недоступно');
            const removed=present&&!transaction?.deleted;
            if(removed){if(transaction)transaction.deleted=true;else present=false;}
            return {rows:removed?[project]:[],rowCount:removed?1:0};
        }
        if(sql.startsWith('INSERT INTO operations')) {
            if(failAudit)throw new Error('Журнал недоступен');
            (transaction?.operations??operations).push(values??[]);return {rows:[],rowCount:1};
        }
        throw new Error('Неожиданный SQL: '+sql);
    };
    const pool={query:(sql:string,values?:unknown[])=>query(sql,values),connect:async()=>{
        const transaction:Transaction={deleted:false,operations:[]};
        return {query:(sql:string,values?:unknown[])=>query(sql,values,transaction),release};
    }};
    adapter.pool=pool;
    return {db:new CatalogDb('postgresql://isolated'),operations,calls,release,present:()=>present,
        failAudit:()=>{failAudit=true;},failDelete:()=>{failDelete=true;},remove:()=>{present=false;}};
}

describe('Транзакционное удаление проекта и журнал операции',()=>{
    beforeEach(()=>vi.clearAllMocks());

    it('Отказ журнала сохраняет проект и отклоняет запрос вместо успешного удаления',async()=>{
        const f=fixture();f.failAudit();
        await expect(f.db.deleteProject(project.id,'operator@example.test')).rejects.toThrow('Журнал недоступен');
        expect(f.present()).toBe(true);expect(f.operations).toHaveLength(0);
        expect(f.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();
    });

    it('Успех сохраняет исходные ID, имя и исполнителя одной операции до COMMIT',async()=>{
        const f=fixture();expect(await f.db.deleteProject(project.name,'operator@example.test')).toBe(true);
        expect(f.present()).toBe(false);expect(f.operations).toHaveLength(1);
        expect(f.operations[0]).toEqual([expect.stringMatching(/^op-/),project.id,'operator@example.test',`Удаление проекта «${project.name}»`]);
        expect(f.calls.find(([sql])=>sql.startsWith('SELECT'))?.[0]).toContain('FOR UPDATE');
        expect(f.calls.find(([sql])=>sql.startsWith('DELETE'))?.[1]).toEqual([project.id]);
        expect(f.calls.at(-1)?.[0]).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();
    });

    it('Отказ DELETE не создаёт успешную операцию и освобождает соединение',async()=>{
        const f=fixture();f.failDelete();
        await expect(f.db.deleteProject(project.id,'operator@example.test')).rejects.toThrow('Удаление недоступно');
        expect(f.present()).toBe(true);expect(f.operations).toHaveLength(0);
        expect(f.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();
    });

    it('Отсутствующий проект не оставляет ложной операции удаления',async()=>{
        const f=fixture();f.remove();expect(await f.db.deleteProject(project.id,'operator@example.test')).toBe(false);
        expect(f.operations).toHaveLength(0);expect(f.calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);
        expect(f.calls.at(-1)?.[0]).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();
    });

    it('Два удаления оставляют одну операцию; повтор получает отсутствие проекта',async()=>{
        const f=fixture(),results=await Promise.all([f.db.deleteProject(project.id,'first@example.test'),f.db.deleteProject(project.id,'second@example.test')]);
        expect(results.filter(Boolean)).toHaveLength(1);expect(f.operations).toHaveLength(1);
        expect(await f.db.deleteProject(project.id,'third@example.test')).toBe(false);expect(f.operations).toHaveLength(1);
    });
});
