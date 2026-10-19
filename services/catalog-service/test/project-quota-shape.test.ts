import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CatalogDb} from '../src/catalog/catalog-db';
import type {IQuota} from '../src/catalog/dto';

const mock=vi.hoisted(()=>({query:vi.fn(),release:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query:mock.query,connect:async()=>({query:mock.query,release:mock.release})})}));
const defaults:IQuota={currentBytesLimit:0,currentBytesUsed:0,retentionBytesLimit:0,retentionBytesUsed:0,stagingBytesLimit:0,stagingBytesUsed:0};

describe('Полная форма квот проекта после частичного сохранения',()=>{
    let db:CatalogDb,quota:unknown;
    beforeEach(()=>{
        vi.clearAllMocks();quota=null;
        mock.query.mockImplementation(async(sql:string,params?:unknown[])=>{
            if(sql.startsWith('INSERT INTO projects')){quota=params?.[4]===null?null:JSON.parse(String(params?.[4]));return {rows:[{id:'prj-quota'}],rowCount:1};}
            if(sql.startsWith('SELECT')&&sql.includes('FROM projects'))return {rows:[{id:'prj-quota',name:'Проверка',state:'ACTIVE',retention:30,quota,fs_root_path:null}]};
            if(sql.startsWith('UPDATE projects'))quota=params?.[3]===null?null:JSON.parse(String(params?.[3]));
            return {rows:[]};
        });
        db=new CatalogDb('postgresql://isolated');
    });

    it.each([null,{currentBytesLimit:1024},'{"currentBytesLimit":1024}'])('Чтение дополняет отсутствующие поля из %j прежними нулями',async stored=>{
        quota=stored;
        expect((await db.getProject('prj-quota'))?.quota).toEqual({...defaults,...(stored?{currentBytesLimit:1024}:{})});
    });

    it('Частичный PATCH первого лимита сохраняет и возвращает все поля квот',async()=>{
        const saved=await db.updateProject('prj-quota',{quotas:{currentBytesLimit:1024} as IQuota},'admin@example.test');
        expect(quota).toEqual({...defaults,currentBytesLimit:1024});expect(saved?.quota).toEqual(quota);
        expect(mock.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    });

    it('PATCH сохраняет прочие лимиты и неизвестные замеры при прежнем строковом JSON',async()=>{
        quota=JSON.stringify({currentBytesLimit:1024,retentionBytesLimit:2048,currentBytesUsed:null,retentionBytesUsed:50});
        const saved=await db.updateProject('prj-quota',{quotas:{stagingBytesLimit:4096} as IQuota},'admin@example.test');
        expect(saved?.quota).toEqual({...defaults,currentBytesLimit:1024,retentionBytesLimit:2048,currentBytesUsed:null,retentionBytesUsed:50,stagingBytesLimit:4096});
        expect(quota).toEqual(saved?.quota);
    });

    it('Создание с одним лимитом сразу сохраняет полный объект квот',async()=>{
        const saved=await db.createProject({name:'Проверка',quotas:{currentBytesLimit:1024} as IQuota});
        expect(quota).toEqual({...defaults,currentBytesLimit:1024});expect(saved.quota).toEqual(quota);
    });

    it('Создание без квот сохраняет прежнее NULL-хранение и полный ответ',async()=>{
        const saved=await db.createProject({name:'Проверка'});
        expect(quota).toBeNull();expect(saved.quota).toEqual(defaults);
    });

    it('Повреждённый строковый JSON сохраняет прежний безопасный ответ с нулями',async()=>{
        quota='{broken';expect((await db.getProject('prj-quota'))?.quota).toEqual(defaults);
    });
});
