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
    let admin:Client,db:RagDb,second:RagDb,created=false,databaseUrl:string;
    const name='nc_rag_contract_test_'+randomUUID().replaceAll('-','');
    beforeAll(async()=>{
        const url=new URL(connection!);
        if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){throw new Error('DB-тест разрешён только на локальном PostgreSQL.');}
        admin=new Client({connectionString:url.toString()});await admin.connect();
        await admin.query(`CREATE DATABASE "${name}"`);created=true;
        url.pathname='/'+name;
        databaseUrl=url.toString();
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
    it('Первые строки атомарно меняют старый пустой профиль; готовность появляется только после seal',async()=>{
        const key='empty-rebind',replacement={...profile,model:'replacement'},values=[row('new')];
        await db.applyDelta(key,[],[],{indexProfile:profile,snapshot:snapshot([])});
        const result=await db.applyDelta(key,values,[],{indexProfile:replacement,snapshot:snapshot(values,false,replacement)});
        expect(result).toMatchObject({rowCount:1,indexProfile:replacement,complete:false,snapshotHash:null});
        await db.applyDelta(key,[],[],{indexProfile:replacement,snapshot:snapshot(values,true,replacement)});
        expect(await db.manifest(key)).toMatchObject({indexProfile:replacement,complete:true,snapshotHash:snapshot(values,false,replacement).hash});
    });
    it('Пустые, legacy, seal-only и ложные нулевые снимки не перепривязывают пустой профиль',async()=>{
        const key='empty-no-change',replacement={...profile,model:'replacement'},values=[row('no-change')];
        await db.applyDelta(key,[],[],{indexProfile:profile,snapshot:snapshot([])});
        const before=await db.manifest(key);
        for(const [upserts,write] of [
            [[],{indexProfile:replacement,snapshot:snapshot(values,false,replacement)}],
            [values,{indexProfile:replacement,snapshot:snapshot([],false,replacement)}],
            [[],{indexProfile:replacement,snapshot:snapshot(values,true,replacement)}],
            [values,{indexProfile:null}],
        ] as const){
            await expect(db.applyDelta(key,[...upserts],[],write)).rejects.toMatchObject({status:409});
            expect(await db.manifest(key)).toEqual(before);
        }
    });
    it('Удаление всех прежних строк не позволяет заменить профиль непустого индекса',async()=>{
        const key='nonempty-no-rebind',old=row('old'),fresh=row('fresh'),replacement={...profile,model:'replacement'};
        await db.applyDelta(key,[old],[],{indexProfile:profile,snapshot:snapshot([old])});
        const before=await db.manifest(key);
        await expect(db.applyDelta(key,[fresh],[old.id],{indexProfile:replacement,snapshot:snapshot([fresh],false,replacement)})).rejects.toMatchObject({status:409});
        expect(await db.manifest(key)).toEqual(before);
    });
    it('Две разные модели после пустого профиля получают одного победителя без смешивания строк',async()=>{
        const key='empty-race';
        await db.applyDelta(key,[],[],{indexProfile:profile,snapshot:snapshot([])});
        const candidates=[{...profile,model:'candidate-b'},{...profile,model:'candidate-c'}];
        const results=await Promise.allSettled(candidates.map((indexProfile,index)=>{
            const value=row('candidate-'+index);
            return (index?second:db).applyDelta(key,[value],[],{indexProfile,snapshot:snapshot([value],false,indexProfile)});
        }));
        expect(results.filter(value=>value.status==='fulfilled')).toHaveLength(1);
        const failed=results.find(value=>value.status==='rejected') as PromiseRejectedResult;
        expect(failed.reason.status).toBe(409);
        const winner=results.findIndex(value=>value.status==='fulfilled');
        expect(await db.manifest(key)).toMatchObject({rowCount:1,indexProfile:candidates[winner],ids:{['candidate-'+winner]:row('candidate-'+winner).contentHash}});
    });
    it('Ошибка COMMIT откатывает новый профиль, строки и счётчик квоты вместе',async()=>{
        const key='empty-rollback',value=row('rollback'),replacement={...profile,model:'replacement'};
        await db.applyDelta(key,[],[],{indexProfile:profile,snapshot:snapshot([])});
        const before=await db.manifest(key),quota=await db.quota(key);
        const sql=new Client({connectionString:databaseUrl});await sql.connect();
        try{
            await sql.query(`CREATE FUNCTION fail_fixture_commit() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.project_key='empty-rollback' THEN RAISE EXCEPTION 'fixture deferred failure'; END IF; RETURN NEW; END $$;
                CREATE CONSTRAINT TRIGGER fixture_commit_failure AFTER INSERT ON rag_chunks
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_fixture_commit()`);
            await expect(db.applyDelta(key,[value],[],{indexProfile:replacement,snapshot:snapshot([value],false,replacement)})).rejects.toThrow('fixture deferred failure');
            expect(await db.manifest(key)).toEqual(before);
            expect(await db.quota(key)).toEqual(quota);
        }finally{await sql.query('DROP TRIGGER IF EXISTS fixture_commit_failure ON rag_chunks;DROP FUNCTION IF EXISTS fail_fixture_commit()');await sql.end();}
    });
    it('Строка другого проекта не препятствует перепривязке пустого индекса',async()=>{
        const key='empty-isolated',value=row('isolated'),replacement={...profile,model:'replacement'};
        const foreign=await db.manifest('bootstrap');
        await db.applyDelta(key,[],[],{indexProfile:profile,snapshot:snapshot([])});
        await db.applyDelta(key,[value],[],{indexProfile:replacement,snapshot:snapshot([value],false,replacement)});
        expect(await db.manifest(key)).toMatchObject({rowCount:1,indexProfile:replacement});
        expect(await db.manifest('bootstrap')).toEqual(foreign);
    });
    it('Строка legacy без вектора тоже запрещает смену закреплённой модели',async()=>{
        const key='legacy-no-vector',replacement={...profile,model:'replacement'},value=row('replacement');
        await db.applyDelta(key,[],[],{indexProfile:profile,snapshot:snapshot([])});
        const sql=new Client({connectionString:databaseUrl});await sql.connect();
        try{await sql.query('INSERT INTO rag_chunks(id,project_key,content,content_hash) VALUES($1,$2,$3,$4)',['raw',key,'legacy',value.contentHash]);}
        finally{await sql.end();}
        const before=await db.manifest(key);
        expect(before).toMatchObject({rowCount:1,usableVectorCount:0,incompleteRows:1});
        await expect(db.applyDelta(key,[value],['raw'],{indexProfile:replacement,snapshot:snapshot([value],false,replacement)})).rejects.toMatchObject({status:409});
        expect(await db.manifest(key)).toEqual(before);
    });
    it('Прямой legacy SQL удерживает общий lock; ожидающий новый профиль видит его COMMIT',async()=>{
        const key='raw-writer-race',replacement={...profile,model:'replacement'},value=row('replacement');
        await db.applyDelta(key,[],[],{indexProfile:profile,snapshot:snapshot([])});
        const sql=new Client({connectionString:databaseUrl});await sql.connect();let work:Promise<unknown>|undefined;
        try{
            await sql.query('BEGIN');
            await sql.query('INSERT INTO rag_chunks(id,project_key,content,content_hash) VALUES($1,$2,$3,$4)',['raw',key,'legacy',value.contentHash]);
            work=second.applyDelta(key,[value],['raw'],{indexProfile:replacement,snapshot:snapshot([value],false,replacement)})
                .then(result=>({result}),error=>({error}));
            let waiting=false;
            for(let attempt=0;attempt<100;attempt++){
                const state=await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1",[name]);
                if(state.rowCount){waiting=true;break;}
                await new Promise(resolve=>setTimeout(resolve,10));
            }
            expect(waiting).toBe(true);await sql.query('COMMIT');
            expect(await work).toMatchObject({error:{status:409}});
            expect(await db.manifest(key)).toMatchObject({rowCount:1,indexProfile:profile,ids:{raw:value.contentHash}});
        }finally{await sql.query('ROLLBACK');await sql.end();await work;}
    });
});
