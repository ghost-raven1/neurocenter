import {describe,it,expect,vi} from 'vitest';
import {ProjectDatabases} from '../src/rag/project-databases';
import {validateDelta} from '../src/rag/rag-validation';

describe('Ограничение ресурсов RAG',()=>{
    it('Переполнение очереди возвращает 503, после освобождения запросы снова принимаются',async()=>{
        const db=new ProjectDatabases();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
        vi.spyOn(db,'projects').mockImplementation(async()=>{await gate;return [];});
        const pending=Array.from({length:24},()=>db.withProject('unknown',async()=>{}).catch(error=>error.status));
        try{
            await expect(db.withProject('overflow',async()=>{})).rejects.toMatchObject({status:503});release();
            expect(await Promise.all(pending)).toEqual(Array(24).fill(404));await expect(db.withProject('after',async()=>{})).rejects.toMatchObject({status:404});
        }finally{release();await db.onModuleDestroy();}
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
