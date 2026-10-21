import {beforeEach,describe,expect,it,vi} from 'vitest';
import {RagDb} from '../src/rag/rag-db';

const fixture=vi.hoisted(()=>({query:vi.fn(),end:vi.fn(),setupQuota:vi.fn(),migrate:vi.fn()}));
vi.mock('../src/database/migrations',()=>({migrateRag:fixture.migrate,checkRagQuotaMigration:async()=>true}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query:fixture.query,end:fixture.end,connect:async()=>({query:fixture.query,release:vi.fn()})})}));
vi.mock('../src/rag/quota/rag-quota',async original=>({
    ...await original<typeof import('../src/rag/quota/rag-quota')>(),setupRagQuota:fixture.setupQuota,
}));

describe('Восстановление RAG после временного отказа PostgreSQL',()=>{
    beforeEach(()=>{
        fixture.query.mockReset().mockResolvedValue({rows:[]});
        fixture.setupQuota.mockReset().mockResolvedValue(undefined);
        fixture.migrate.mockReset().mockResolvedValue(undefined);
    });
    const database=()=>new RagDb({url:'postgresql://fixture/own'});

    it('Ошибка подключения не закрепляется навсегда: следующий запрос повторяет инициализацию',async()=>{
        const db=database();fixture.migrate.mockRejectedValueOnce(Object.assign(new Error('Временный отказ'),{code:'ECONNRESET'}));
        await expect(db.setup()).rejects.toThrow('Временный отказ');
        await expect(db.setup()).resolves.toBeUndefined();expect(fixture.setupQuota).toHaveBeenCalledOnce();
    });
    it('Отказ настройки квоты позволяет повторить частично созданную схему',async()=>{
        const db=database();fixture.setupQuota.mockRejectedValueOnce(new Error('Квота временно недоступна'));
        await expect(db.setup()).rejects.toThrow('Квота временно недоступна');
        await expect(db.setup()).resolves.toBeUndefined();expect(fixture.setupQuota).toHaveBeenCalledTimes(2);
    });
    it('Параллельные запросы делят одну попытку, после отказа делят один успешный повтор',async()=>{
        const db=database();fixture.migrate.mockRejectedValueOnce(new Error('Первая попытка'));
        const first=db.setup(),same=db.setup();expect(first).toBe(same);
        await expect(first).rejects.toThrow('Первая попытка');
        const retry=db.setup();expect(db.setup()).toBe(retry);await retry;
        expect(db.setup()).toBe(retry);expect(fixture.setupQuota).toHaveBeenCalledOnce();
    });
    it.each(['42501','57014','ECONNRESET'])('Ошибка измерения %s не выдаётся за пустую базу',async code=>{
        const db=database();fixture.query.mockRejectedValueOnce(Object.assign(new Error('Недоступно измерение'),{code}));
        await expect(db.retainedEstimateBytes('own')).rejects.toMatchObject({status:503});
    });
    it('Отсутствующая таблица не маскируется нулём; здоровое измерение восстанавливается',async()=>{
        const db=database();fixture.query.mockRejectedValueOnce(Object.assign(new Error('Таблица не создана'),{code:'42P01'}));
        await expect(db.retainedEstimateBytes('own')).rejects.toMatchObject({status:503});
        fixture.query.mockResolvedValueOnce({rows:[{tsize:'8192',pcount:'2',tcount:'4'}]});
        await expect(db.retainedEstimateBytes('own')).resolves.toBe(4096);
    });
});
