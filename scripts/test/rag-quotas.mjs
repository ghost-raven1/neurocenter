import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../../services/rag-sync-service/package.json',import.meta.url));
const {Pool}=require('pg');const {RagDb}=require('../../services/rag-sync-service/dist/rag/rag-db.js');
const {RAG_QUOTA_MIGRATION}=require('../../services/rag-sync-service/dist/rag/quota/rag-quota-schema.js');
const administrator=new Pool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/postgres'});
const suffix=randomUUID().replaceAll('-','').slice(0,12);const database='qa_rag_quota_'+suffix;const role='qa_rag_quota_'+suffix;const password=randomBytes(24).toString('hex');
const url=new URL(process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/postgres');url.username=role;url.password=password;url.pathname='/'+database;
let db;let pool;let createdRole=false;let createdDatabase=false;const passed=[];
const row=(id,content='Проверка',overrides={})=>({id,filePath:'README.md',content,description:null,startLine:null,endLine:null,language:null,kind:'',role:null,quirkType:null,tags:null,contentHash:createHash('sha256').update(content).digest('hex'),embedding:null,...overrides});
const rowBytes=(key,value)=>[value.id,key,value.filePath,value.content,value.description,value.language,value.kind,value.role,value.quirkType,value.tags,value.contentHash].reduce((sum,item)=>sum+Buffer.byteLength(item||''),0)+(value.startLine===null?0:4)+(value.endLine===null?0:4)+(value.embedding===null?0:8+4*value.embedding.length);
const check=async(name,action)=>{await action();passed.push(name);console.log('OK '+name);};
const quota=key=>db.quota(key);const setQuota=async(key,limitBytes,expectedRevision)=>(db.quota(key,{limitBytes,expectedRevision:expectedRevision??(await quota(key)).revision}));
const actual=async key=>Number((await pool.query('SELECT COALESCE(sum(public.neurocenter_rag_row_bytes(c)),0) AS n FROM rag_chunks c WHERE project_key=$1',[key])).rows[0].n);
async function assertCounter(key){assert.equal((await quota(key)).usedBytes,await actual(key));}
try{
    await mkdir('.run/production-stage-3',{recursive:true,mode:0o700});
    await administrator.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);createdRole=true;
    await administrator.query(`CREATE DATABASE ${database} OWNER ${role}`);createdDatabase=true;
    const ownerUrl=new URL(process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/postgres');ownerUrl.pathname='/'+database;const owner=new Pool({connectionString:ownerUrl.href});
    try{await owner.query('CREATE EXTENSION vector');}finally{await owner.end();}
    db=new RagDb({url:url.href,dim:2});pool=new Pool({connectionString:url.href,max:3});await db.setup();
    await check('Миграция и лимит создаются рабочей ролью без superuser',async()=>{
        assert.equal((await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper,false);
        assert.equal((await pool.query('SELECT version FROM neurocenter_rag_migrations')).rows[0].version,RAG_QUOTA_MIGRATION);
        const value=await quota('boundary');assert.equal(value.usedBytes,0);assert.equal(value.limitBytes,1024**3);
    });
    const boundary=row('один','Русский текст 日本語',{embedding:[0.5,1],startLine:0,endLine:1,tags:'важное'});const bytes=rowBytes('boundary',boundary);
    await check('UTF8, метаданные и вектор учитываются, точное равенство лимиту разрешено',async()=>{
        await setQuota('boundary',bytes);await db.applyDelta('boundary',[boundary],[]);assert.equal((await quota('boundary')).usedBytes,bytes);assert.equal((await quota('boundary')).availableBytes,0);
    });
    await check('Превышение лимита возвращает 413 и не меняет строки или счётчик',async()=>{
        await assert.rejects(db.applyDelta('boundary',[row('два')],[]),error=>error.status===413&&error.response.code==='RAG_QUOTA_EXCEEDED');assert.equal(await db.count('boundary'),1);await assertCounter('boundary');
    });
    await check('Повтор уже выполненного upsert не расходует место повторно',async()=>{
        await Promise.all(Array.from({length:12},()=>db.applyDelta('boundary',[boundary],[])));assert.equal(await db.count('boundary'),1);assert.equal((await quota('boundary')).usedBytes,bytes);
    });
    await check('Уменьшение строки и удаление освобождают квоту',async()=>{
        await db.applyDelta('boundary',[row('один','')],[]);assert.ok((await quota('boundary')).usedBytes<bytes);await db.applyDelta('boundary',[],['один']);assert.equal((await quota('boundary')).usedBytes,0);
    });
    await check('Неудачная дельта откатывает и удаления, и новые записи целиком',async()=>{
        const original=row('old','Исходное');await setQuota('atomic',rowBytes('atomic',original)+5);await db.applyDelta('atomic',[original],[]);
        await assert.rejects(db.applyDelta('atomic',[row('new','x'.repeat(1000))],['old']),error=>error.status===413);assert.deepEqual(Object.keys(await db.manifest('atomic')),['old']);await assertCounter('atomic');
    });
    await check('Прямой SQL старого приложения также не обходит ограничение',async()=>{
        await assert.rejects(pool.query("INSERT INTO rag_chunks(id,project_key,content,content_hash) VALUES('bypass','atomic',repeat('x',1000),'hash')"),error=>error.code==='23514'&&error.constraint==='rag_storage_quota_limit');assert.equal(await db.count('atomic'),1);await assertCounter('atomic');
    });
    await check('Рост первой порции и сокращение следующей оцениваются по итоговой транзакции',async()=>{
        const initial=Array.from({length:100},(_,i)=>row('r'+String(i).padStart(3,'0'),'x'.repeat(20)));await db.applyDelta('swap',initial,[]);await setQuota('swap',(await quota('swap')).usedBytes);
        const changed=initial.map((value,i)=>row(value.id,i<50?'x'.repeat(30):''));await db.applyDelta('swap',changed,[]);assert.ok((await quota('swap')).availableBytes>0);await assertCounter('swap');
    });
    await check('Двадцать четыре конкурентные записи не превышают общий лимит проекта',async()=>{
        const key='parallel';const size=rowBytes(key,row('p000'));await setQuota(key,4*size);
        const result=await Promise.allSettled(Array.from({length:24},(_,i)=>db.applyDelta(key,[row('p'+String(i).padStart(3,'0'))],[])));
        assert.equal(result.filter(item=>item.status==='fulfilled').length,4);assert.ok(result.filter(item=>item.status==='rejected').every(item=>item.reason.status===413));assert.equal((await quota(key)).usedBytes,4*size);await assertCounter(key);
    });
    await check('Одновременный повтор одного фрагмента учитывается один раз',async()=>{
        const key='retry';const value=row('same');await setQuota(key,rowBytes(key,value));await Promise.all(Array.from({length:20},()=>db.applyDelta(key,[value],[])));assert.equal(await db.count(key),1);await assertCounter(key);
    });
    await check('Устаревший редактор не перезаписывает лимит, потерянный ответ безопасно повторяется',async()=>{
        const before=await quota('policy');const saved=await setQuota('policy',500,before.revision);assert.equal(saved.revision,before.revision+1);
        await assert.rejects(setQuota('policy',600,before.revision),error=>error.status===409);assert.equal((await setQuota('policy',500,before.revision)).revision,saved.revision);
    });
    await check('Изменение лимита и аудит автора фиксируются одной транзакцией',async()=>{
        const before=await quota('audit');await db.quota('audit',{limitBytes:1000,expectedRevision:before.revision},'admin@example.test');
        const event=(await pool.query("SELECT actor,before_bytes,after_bytes FROM rag_quota_events WHERE project_key='audit' ORDER BY id DESC LIMIT 1")).rows[0];assert.equal(event.actor,'admin@example.test');assert.equal(Number(event.after_bytes),1000);assert.equal(Number(event.before_bytes),before.limitBytes);
    });
    await check('Ошибка аудита откатывает изменение лимита',async()=>{
        const before=await quota('audit');await pool.query("CREATE FUNCTION quota_test_deny_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$; CREATE TRIGGER quota_test_audit_failure BEFORE INSERT ON rag_quota_events FOR EACH ROW EXECUTE FUNCTION quota_test_deny_audit()");
        try{await assert.rejects(db.quota('audit',{limitBytes:1200,expectedRevision:before.revision},'admin@example.test'));assert.deepEqual(await quota('audit'),before);}
        finally{await pool.query('DROP TRIGGER quota_test_audit_failure ON rag_quota_events; DROP FUNCTION quota_test_deny_audit()');}
    });
    await check('Снижение ниже занятых байтов и превышение максимума отклоняются',async()=>{
        await assert.rejects(setQuota('atomic',1),error=>error.status===409);await assert.rejects(setQuota('atomic',17*1024**3),error=>error.status===400);await assertCounter('atomic');
    });
    await check('Проекты в старой общей базе имеют независимые бюджеты',async()=>{
        await setQuota('small',1);await assert.rejects(db.applyDelta('small',[row('a')],[]),error=>error.status===413);await db.applyDelta('other',[row('a')],[]);assert.equal((await quota('small')).usedBytes,0);assert.ok((await quota('other')).usedBytes>0);
    });
    await check('Явный ROLLBACK отменяет строку и изменение счётчика',async()=>{
        const client=await pool.connect();try{await client.query('BEGIN');await client.query("INSERT INTO rag_chunks(id,project_key,content,content_hash) VALUES('rollback','other','Тест','hash')");await client.query('ROLLBACK');}finally{client.release();}assert.equal(await db.count('other'),1);await assertCounter('other');
    });
    await check('Перезапуск и повторная миграция сохраняют пользовательский лимит и ревизию',async()=>{
        const before=await quota('policy');const second=new RagDb({url:url.href,dim:2});try{await second.setup();assert.deepEqual(await second.quota('policy'),before);}finally{await second.close();}
        assert.equal(Number((await pool.query('SELECT count(*) AS n FROM neurocenter_rag_migrations')).rows[0].n),1);
    });
    await check('Подмена применённой миграции останавливает запуск вместо тихого изменения схемы',async()=>{
        const checksum=(await pool.query('SELECT checksum FROM neurocenter_rag_migrations')).rows[0].checksum;await pool.query("UPDATE neurocenter_rag_migrations SET checksum='changed'");const second=new RagDb({url:url.href,dim:2});
        try{await assert.rejects(second.setup(),/Изменена применённая миграция/);}finally{await second.close();await pool.query('UPDATE neurocenter_rag_migrations SET checksum=$1',[checksum]);}
    });
    await check('Конкурентное снижение лимита и запись сериализуются без превышения',async()=>{
        const key='policy-race';const size=rowBytes(key,row('r1'));await setQuota(key,size*2);const before=await quota(key);
        const results=await Promise.allSettled([setQuota(key,size,before.revision),db.applyDelta(key,[row('r1')],[]),db.applyDelta(key,[row('r2')],[])]);
        assert.ok(results.filter(item=>item.status==='rejected').every(item=>[409,413].includes(item.reason.status)));const value=await quota(key);assert.ok(value.usedBytes<=value.limitBytes);await assertCounter(key);
    });
    await check('Длительная блокировка возвращает 503, освобождение позволяет безопасный повтор',async()=>{
        const client=await pool.connect();try{await client.query('BEGIN');await client.query('LOCK TABLE rag_chunks IN ROW EXCLUSIVE MODE');await client.query('SELECT pg_advisory_xact_lock(72465385)');await assert.rejects(db.applyDelta('busy',[row('a')],[]),error=>error.status===503);}finally{await client.query('ROLLBACK');client.release();}
        await db.applyDelta('busy',[row('a')],[]);await assertCounter('busy');
    });
    await check('Перенос старой базы учитывает новый ID и не обрезает данные новым лимитом',async()=>{
        const values=[row('legacy-a','x'.repeat(1000)),row('legacy-b','Русские знания')];await db.applyDelta('old',values,[]);
        await pool.query('UPDATE rag_storage_settings SET default_bytes=1');const projected=await db.legacyQuotaBytes('old','prj-new-constant-id');assert.equal(projected,values.reduce((sum,value)=>sum+rowBytes('prj-new-constant-id',value),0));
        await db.reserveLegacyQuota('prj-new-constant-id',projected);await db.applyDelta('prj-new-constant-id',values,[]);assert.equal((await quota('prj-new-constant-id')).usedBytes,projected);assert.equal((await quota('prj-new-constant-id')).limitBytes,projected);
        await pool.query('UPDATE rag_storage_settings SET default_bytes=$1',[1024**3]);
    });
    await check('Перенос не повышает лимит, уже изменённый администратором',async()=>{
        await setQuota('protected-import',1000);await assert.rejects(db.reserveLegacyQuota('protected-import',2000),error=>error.status===409);assert.equal((await quota('protected-import')).limitBytes,1000);
    });
    await check('TRUNCATE освобождает учёт всех проектов и сохраняет ограничения',async()=>{
        const before=await quota('policy');await pool.query('TRUNCATE rag_chunks');assert.equal((await quota('parallel')).usedBytes,0);assert.equal((await quota('policy')).limitBytes,before.limitBytes);
    });
    await check('Первичная миграция сохраняет старые строки больше нового значения по умолчанию',async()=>{
        // Только собственная временная БД: имитируем схему до появления квот.
        await pool.query('DROP TABLE rag_storage_budget CASCADE; DROP TABLE rag_storage_settings; DROP TABLE rag_quota_events; DROP TABLE neurocenter_rag_migrations');
        const functions=(await pool.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'neurocenter_%'")).rows;
        for(const {signature} of functions){assert.match(signature,/^neurocenter_[a-z_]+\([a-z_ .]*\)$/);await pool.query('DROP FUNCTION IF EXISTS '+signature+' CASCADE');}
        await pool.query("INSERT INTO rag_chunks(id,project_key,content,content_hash) VALUES('old','pre-quota','Старые знания','old-hash')");
        const previous=process.env.RAG_DEFAULT_QUOTA_BYTES;process.env.RAG_DEFAULT_QUOTA_BYTES='1';const second=new RagDb({url:url.href,dim:2});
        try{await second.setup();const state=await second.quota('pre-quota');assert.equal(state.usedBytes,await actual('pre-quota'));assert.equal(state.limitBytes,state.usedBytes);assert.equal(await second.count('pre-quota'),1);await assert.rejects(second.applyDelta('pre-quota',[row('extra')],[]),error=>error.status===413);}
        finally{await second.close();if(previous===undefined){delete process.env.RAG_DEFAULT_QUOTA_BYTES;}else{process.env.RAG_DEFAULT_QUOTA_BYTES=previous;}}
    });
}finally{
    if(db){await db.close();}if(pool){await pool.end();}
    if(createdDatabase){await administrator.query(`DROP DATABASE ${database}`);}if(createdRole){await administrator.query(`DROP ROLE ${role}`);}await administrator.end();
    await writeFile('.run/production-stage-3/rag-quotas.json',JSON.stringify({passed,checks:passed.length,databaseRemoved:createdDatabase,roleRemoved:createdRole},null,2)+'\n');
}
console.log(JSON.stringify({passed:passed.length}));
