import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/rag/rag-features',()=>({requireRagFeatures:vi.fn(async()=>{})}));
import {ProjectDatabases} from '../src/rag/project-databases';
import {validateDelta} from '../src/rag/rag-validation';
import type {DatabaseLifecycle} from '../src/retired-databases/database-lifecycle';

describe('Ограничение ресурсов RAG',()=>{
    it('Переполнение очереди возвращает 503, после освобождения запросы снова принимаются',async()=>{
        const db=new ProjectDatabases({setCacheCloser:()=>{}} as unknown as DatabaseLifecycle);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
        vi.spyOn(db,'projects').mockImplementation(async()=>{await gate;return [];});
        const pending=Array.from({length:24},()=>db.withProject('unknown',async()=>{}).catch(error=>error.status));
        try{
            await expect(db.withProject('overflow',async()=>{})).rejects.toMatchObject({status:503});release();
            expect(await Promise.all(pending)).toEqual(Array(24).fill(404));await expect(db.withProject('after',async()=>{})).rejects.toMatchObject({status:404});
        }finally{release();await db.onModuleDestroy();}
    });
    it('Обычное действие держит lifecycle lease до завершения и освобождает её после ошибки',async()=>{
        const release=vi.fn(async()=>{}),lifecycle={setCacheCloser:vi.fn(),lease:vi.fn(async()=>release)},db=new ProjectDatabases(lifecycle as unknown as DatabaseLifecycle);
        const target={setup:vi.fn(async()=>{}),close:vi.fn(async()=>{}),configureQuota:vi.fn(async()=>{})};
        vi.spyOn(db,'platformQuota').mockResolvedValue({defaultBytes:1024,maximumBytes:2048,revision:1,updatedAt:new Date().toISOString(),updatedBy:'fixture'});
        vi.spyOn(db,'projects').mockResolvedValue([{id:'prj-lease',name:'Own lease fixture'}]);vi.spyOn(db as any,'ensure').mockResolvedValue(undefined);
        (db as any).cache.set('prj-lease',{db:target,used:Date.now(),active:0});
        try{await expect(db.withProject('prj-lease',async()=>{expect(release).not.toHaveBeenCalled();throw Error('own action failed');})).rejects.toThrow('own action failed');expect(lifecycle.lease).toHaveBeenCalledWith('prj-lease');expect(release).toHaveBeenCalledOnce();}
        finally{await db.onModuleDestroy();}
    });
    it('Слишком большие пакеты отклоняются до открытия SQL-транзакции',()=>{
        const chunk={id:'test',filePath:'README.md',content:'Инструкция'};
        expect(()=>validateDelta(Array(1001).fill(chunk),[],2560)).toThrow('1000');expect(()=>validateDelta([],Array(10001).fill('test'),2560)).toThrow('10000');
    });
    it('Длина ID измеряется в байтах, чтобы не превысить пределы индекса PostgreSQL',()=>{
        const chunk={id:'я'.repeat(257),filePath:'README.md',content:'Инструкция'};expect(()=>validateDelta([chunk],[],2560)).toThrow();
        expect(()=>validateDelta([{...chunk,id:'test',filePath:'я'.repeat(2049)}],[],2560)).toThrow('4096');
    });
});
