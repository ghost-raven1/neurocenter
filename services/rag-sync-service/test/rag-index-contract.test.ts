import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {normalizeIndexProfile,normalizeChunkRow,rowFingerprint,indexSnapshotHash,embeddingSignature} from '../../shared/rag-index-contract.cjs';
import {validateIndexWrite,requireUsableVectors,readIndexSummary,bindIndexProfile,sealIndex} from '../src/rag/rag-index-state';
import {RagService} from '../src/rag/rag.service';
vi.mock('../src/rag/rag-features',()=>({requireRagFeatures:vi.fn(async()=>{})}));
import type {ProjectDatabases} from '../src/rag/project-databases';
import {write,generation} from './rag-write.fixture';
beforeEach(()=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true})));
afterEach(()=>vi.unstubAllGlobals());

const profile={provider:'ollama',model:'qwen3-embedding:4b',dimension:2560};
const row={id:'a',filePath:'src/a.ts',content:'hello',embedding:[0.1,0.2,0.3]};
const hash='a'.repeat(64);

describe('Общий контракт полного снимка RAG',()=>{
    it('Один content с другим вектором, путём или метаданными имеет другой полный hash',()=>{
        const original=rowFingerprint(row);
        for(const changed of [{...row,embedding:[0.1,0.2,0.4]},{...row,filePath:'src/b.ts'},{...row,description:'описание'},{...row,tags:'["tag"]'},{...row,startLine:4}]){
            expect(rowFingerprint(changed)).not.toBe(original);
        }
        expect(rowFingerprint({...row,contentHash:'untrusted',syncHash:'untrusted'})).toBe(original);
    });
    it('Float32 и очистка текстов дают один hash до и после PostgreSQL',()=>{
        const normalized=normalizeChunkRow({...row,content:'hel\0lo',description:undefined,embedding:[0.1,-0,0.3]});
        expect(normalized.content).toBe('hello');expect(normalized.description).toBeNull();
        expect(normalized.embedding).toEqual([Math.fround(0.1),0,Math.fround(0.3)]);
        expect(rowFingerprint(normalized)).toBe(rowFingerprint({...row,content:'hel\0lo',embedding:[0.1,-0,0.3]}));
    });
    it.each([{...profile,url:'http://localhost'},{...profile,apiKey:'fixture'},{...profile,model:'https://provider/model'},{...profile,provider:'OLLAMA'},{...profile,dimension:0},{...profile,dimension:1.5}])('Непубличные или некорректные метаданные не попадают в профиль: %j',value=>{
        expect(()=>normalizeIndexProfile(value)).toThrow();
    });
    it('Seal не зависит от порядка строк, но меняется при замене модели',()=>{
        expect(indexSnapshotHash(profile,{a:hash,b:'b'.repeat(64)})).toBe(indexSnapshotHash(profile,{b:'b'.repeat(64),a:hash}));
        expect(indexSnapshotHash(profile,{a:hash})).not.toBe(indexSnapshotHash({...profile,model:'other'},{a:hash}));
    });
    it('Подпись подключения исключает ключи и credentials, сохраняя модель и endpoint',()=>{
        const signature=embeddingSignature(profile,'HTTP://User:secret@LOCALHOST:11435/api/?api_key=secret#secret');
        expect(signature).toBe(embeddingSignature(profile,'http://localhost:11435/api'));
        expect(signature).not.toBe(embeddingSignature({...profile,model:'other'},'http://localhost:11435/api'));
        expect(signature).not.toBe(embeddingSignature(profile,'http://localhost:11436/api'));
        expect(()=>embeddingSignature(profile,'file:///secret')).toThrow();
    });
});

describe('Профиль проверяется до изменения данных',()=>{
    it.each([null,undefined,Array(2560).fill(0)])('Новый профиль не принимает отсутствующий или нулевой вектор',async embedding=>{
        const withProject=vi.fn();const service=new RagService({withProject} as unknown as ProjectDatabases);
        await expect(service.applyDelta(write([{...row,contentHash:'client',embedding:embedding as number[]|null}],[],profile,{hash,rowCount:1,complete:false}))).rejects.toMatchObject({status:400});
        expect(withProject).not.toHaveBeenCalled();
    });
    it('Проверка размерности и финального пустого пакета не открывает проектную БД',async()=>{
        const withProject=vi.fn();const service=new RagService({withProject} as unknown as ProjectDatabases);
        const mismatch=write([],['old'],{...profile,dimension:3},{hash,rowCount:1,complete:false});mismatch.context.profile=profile;
        await expect(service.applyDelta(mismatch)).rejects.toMatchObject({status:409});
        await expect(service.applyDelta(write([],['old'],profile,{hash,rowCount:1,complete:true}))).rejects.toMatchObject({status:400});
        expect(withProject).not.toHaveBeenCalled();
    });
    it('SHA текста сохраняется независимо от полного fingerprint',async()=>{
        const applyDelta=vi.fn(async()=>({upserted:1,deleted:0}));const withProject=vi.fn(async(key,action)=>action({applyDelta},key));
        const service=new RagService({withProject} as unknown as ProjectDatabases);
        await service.applyDelta(write([{...row,embedding:Array(2560).fill(0.1),content:'hel\0lo',contentHash:'client'}],[],profile,{hash,rowCount:1,complete:false}));
        const saved=applyDelta.mock.calls[0][2][0];
        expect(saved.contentHash).toBe(createHash('sha256').update('hello').digest('hex'));
        expect(saved.syncHash).toBe(rowFingerprint(saved));
    });
    it('Профиль без snapshot и snapshot без профиля не понижаются до legacy',()=>{
        expect(()=>validateIndexWrite(profile,undefined,2560)).toThrow();expect(()=>validateIndexWrite(undefined,{hash,rowCount:1,complete:false},2560)).toThrow();
    });
    it('Привязанный профиль отвергает старый мост и иную модель без UPDATE/DELETE',async()=>{
        const query=vi.fn(async()=>({rows:[{index_profile:profile}]}));
        await expect(bindIndexProfile({query} as never,'p',generation('p'),{indexProfile:null})).rejects.toMatchObject({status:409});
        await expect(bindIndexProfile({query} as never,'p',generation('p'),{indexProfile:{...profile,model:'other'}})).rejects.toMatchObject({status:409});
        expect(query.mock.calls.every(([sql])=>String(sql).startsWith('SELECT'))).toBe(true);
    });
    it('Валидные ненулевые float32 остаются допустимыми',()=>{expect(()=>requireUsableVectors([{embedding:[0.1,0,0]}],3)).not.toThrow();});
});

describe('Готовность требует полного seal',()=>{
    const state={row_count:1,last_synced_at:null,usable:1,incomplete:0,index_profile:profile,complete:true,snapshot_hash:hash,snapshot_rows:1};
    it.each([{...state,complete:false},{...state,incomplete:1},{...state,usable:0},{...state,row_count:0,usable:0},{...state,index_profile:null},{...state,snapshot_rows:2}])('Наличие строк не подменяет подтверждение: %j',async value=>{
        const summary=await readIndexSummary({query:async()=>({rows:[value]})} as never,'p',generation('p'));expect(summary.complete).toBe(false);expect(summary.indexState).not.toBe('ready');
    });
    it('Первая порция многопакетного bootstrap не может подтвердить весь snapshot',async()=>{
        const query=vi.fn(async()=>({rows:[{...state,complete:false,ids:{a:'legacy'},fingerprints:{a:hash}}]}));
        await expect(sealIndex({query} as never,'p',generation('p'),{indexProfile:profile,snapshot:{hash:indexSnapshotHash(profile,{a:hash,b:hash}),rowCount:2,complete:true}})).rejects.toMatchObject({status:409});
        expect(query).toHaveBeenCalledTimes(1);
    });
});
