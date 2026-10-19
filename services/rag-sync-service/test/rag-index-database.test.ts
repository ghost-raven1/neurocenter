import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {RagDb,type IUpsertRow} from '../src/rag/rag-db';
import {rowFingerprint,indexSnapshotHash} from '../../shared/rag-index-contract.cjs';

vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));
const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
const profile={provider:'ollama',model:'fixture-embedding',dimension:3};
const row=(id:string,embedding=[0.1,0.2,0.3]):IUpsertRow=>({id,filePath:`src/${id}.ts`,content:id,description:null,startLine:1,endLine:1,
    language:'typescript',kind:'code',role:null,quirkType:null,tags:null,embedding,
    contentHash:createHash('sha256').update(id).digest('hex')});
const snapshot=(values:IUpsertRow[],complete=false,indexProfile=profile)=>({hash:indexSnapshotHash(indexProfile,Object.fromEntries(values.map(value=>[value.id,rowFingerprint(value)]))),rowCount:values.length,complete});

describe.skipIf(!connection)('Профили и seal RAG в отдельной временной PostgreSQL БД',()=>{
    let admin:Client,db:RagDb,second:RagDb,created=false;
    const name='nc_rag_contract_test_'+randomUUID().replaceAll('-','');
    beforeAll(async()=>{
        const url=new URL(connection!);
        if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){throw new Error('DB-тест разрешён только на локальном PostgreSQL.');}
        admin=new Client({connectionString:url.toString()});await admin.connect();
        await admin.query(`CREATE DATABASE "${name}"`);created=true;
        url.pathname='/'+name;
        const seed=new Client({connectionString:url.toString()});await seed.connect();
        try{
            await seed.query(`CREATE EXTENSION vector;CREATE TABLE rag_chunks(
                id TEXT NOT NULL,project_key TEXT NOT NULL,file_path TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,
                description TEXT,start_line INTEGER,end_line INTEGER,language TEXT,kind TEXT NOT NULL DEFAULT '',role TEXT,
                quirk_type TEXT,tags TEXT,content_hash TEXT NOT NULL,embedding vector(3),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(id,project_key))`);
            await seed.query("INSERT INTO rag_chunks(id,project_key,file_path,content,content_hash,embedding) VALUES('old','legacy','old.ts','legacy',$1,'[1,0,0]')",[createHash('sha256').update('legacy').digest('hex')]);
        }finally{await seed.end();}
        db=new RagDb({url:url.toString(),dim:3});second=new RagDb({url:url.toString(),dim:3});
        await db.setup();await second.setup();
    },30000);
    afterAll(async()=>{
        await Promise.all([db?.close(),second?.close()]);
        if(created){await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);}
        await admin?.end();
    });

    it('Идемпотентная миграция сохраняет старые строки и не приписывает им модель или полный hash',async()=>{
        const manifest=await db.manifest('legacy');
        expect(manifest.ids.old).toBe(createHash('sha256').update('legacy').digest('hex'));
        expect(manifest.fingerprints).toEqual({});expect(manifest).toMatchObject({rowCount:1,indexProfile:null,incompleteRows:1,complete:false,indexState:'unverified'});
    });
    it('Legacy строки получают подтверждение только после повторной отправки и полного seal',async()=>{
        const values=await db.rowsPage('legacy',1000,0);
        const legacyHash=(await db.manifest('legacy')).ids.old;
        await db.applyDelta('legacy',values,[],{indexProfile:profile,snapshot:snapshot(values)});
        expect((await db.summary('legacy')).complete).toBe(false);
        await db.applyDelta('legacy',[],[],{indexProfile:profile,snapshot:snapshot(values,true)});
        const state=await db.manifest('legacy');
        expect(state.ids.old).toBe(legacyHash);expect(state.fingerprints.old).toBe(rowFingerprint(values[0]));expect(state.complete).toBe(true);
    });
    it('Первая порция bootstrap не готова; seal отвергает отсутствующие строки и подтверждает только полный снимок',async()=>{
        const values=[row('a'),row('b')],state={indexProfile:profile,snapshot:snapshot(values)};
        await db.applyDelta('bootstrap',[values[0]],[],state);
        expect(await db.summary('bootstrap')).toMatchObject({rowCount:1,incompleteRows:0,complete:false,indexState:'syncing'});
        await expect(db.applyDelta('bootstrap',[],[],{indexProfile:profile,snapshot:snapshot(values,true)})).rejects.toMatchObject({status:409});
        await db.applyDelta('bootstrap',[values[1]],[],state);
        const sealed=await db.applyDelta('bootstrap',[],[],{indexProfile:profile,snapshot:snapshot(values,true)});
        expect(sealed).toMatchObject({rowCount:2,usableVectorCount:2,incompleteRows:0,complete:true,indexState:'ready',snapshotHash:snapshot(values).hash});
    });
    it('Чужая модель и legacy мост не могут удалить существующие подтверждённые знания',async()=>{
        const before=await db.manifest('bootstrap');
        await expect(db.applyDelta('bootstrap',[],['a'],{indexProfile:{...profile,model:'different'},snapshot:snapshot([row('b')])})).rejects.toMatchObject({status:409});
        await expect(db.applyDelta('bootstrap',[],['a'])).rejects.toMatchObject({status:409});
        expect(await db.manifest('bootstrap')).toEqual(before);
    });
    it('Тот же content с новым вектором обновляет fingerprint и снимает старую готовность до seal',async()=>{
        const changed=row('a',[0.9,0.2,0.3]),values=[changed,row('b')];
        const previous=(await db.manifest('bootstrap')).fingerprints.a;
        await db.applyDelta('bootstrap',[changed],[],{indexProfile:profile,snapshot:snapshot(values)});
        const manifest=await db.manifest('bootstrap');
        expect(manifest.ids.a).toBe(changed.contentHash);expect(manifest.fingerprints.a).not.toBe(previous);
        expect(manifest.fingerprints.a).toBe(rowFingerprint(changed));expect(manifest.complete).toBe(false);
        await db.applyDelta('bootstrap',[],[],{indexProfile:profile,snapshot:snapshot(values,true)});
        expect((await db.summary('bootstrap')).complete).toBe(true);
    });
    it('Параллельные первые клиенты не смешивают модели',async()=>{
        const value=row('concurrent');
        const result=await Promise.allSettled([
            db.applyDelta('race',[value],[],{indexProfile:profile,snapshot:snapshot([value])}),
            second.applyDelta('race',[value],[],{indexProfile:{...profile,model:'second-model'},snapshot:snapshot([value],false,{...profile,model:'second-model'})}),
        ]);
        expect(result.filter(value=>value.status==='fulfilled')).toHaveLength(1);
        expect(result.filter(value=>value.status==='rejected')).toHaveLength(1);
        const failure=result.find(value=>value.status==='rejected') as PromiseRejectedResult;
        expect(failure.reason.status).toBe(409);expect((await db.summary('race')).rowCount).toBe(1);
    });
    it('Неверный final hash и нулевой вектор не меняют готовый снимок',async()=>{
        const before=await db.manifest('bootstrap');
        await expect(db.applyDelta('bootstrap',[],[],{indexProfile:profile,snapshot:{hash:'a'.repeat(64),rowCount:2,complete:true}})).rejects.toMatchObject({status:409});
        await expect(db.applyDelta('bootstrap',[row('zero',[0,0,0])],['a'],{indexProfile:profile,snapshot:snapshot([row('zero',[0,0,0])])})).rejects.toMatchObject({status:400});
        expect(await db.manifest('bootstrap')).toEqual(before);
    });
});
