import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';

/** Проверяет отказы копирования только в одноразовом production-стеке. */
export async function verifyProductionBackups({check,request,docker,dockerAsync,query,override,projectId,database}){
    const route='/api/projects/'+projectId+'/backups';
    const original=await readFile(override,'utf8');
    const node=script=>docker(['exec','-T','catalog-service','node','-e',script]);
    const files=()=>JSON.parse(node(`const fs=require('fs'),p=require('path'),c=require('crypto');const entries=[];function walk(dir){for(const name of fs.readdirSync(dir)){const f=p.join(dir,name),s=fs.lstatSync(f);if(s.isDirectory())walk(f);else entries.push({file:f,size:s.size,mode:s.mode&511,sha:c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')});}}walk('/app/backups');console.log(JSON.stringify(entries.sort((a,b)=>a.file.localeCompare(b.file))));`));
    const list=async()=>{const result=await request(route);assert.equal(result.status,200);return result.data;};
    async function withPolicy(policy,action){
        const yaml='  catalog-service:\n    environment:\n'+Object.entries(policy).map(([key,value])=>'      '+key+': "'+value+'"').join('\n')+'\n';
        try{await writeFile(override,original+yaml);await dockerAsync(['up','-d','--no-deps','--force-recreate','--wait','catalog-service']);await action();}
        finally{await writeFile(override,original);await dockerAsync(['up','-d','--no-deps','--force-recreate','--wait','catalog-service']);}
    }
    async function denied(status,code,before){
        const result=await request(route,{method:'POST',body:{}});assert.equal(result.status,status,JSON.stringify(result.data));assert.equal(result.data.code,code);
        assert.deepEqual(files(),before);assert.equal(query('postgres',"SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'nc-backup-%'"),'0');
    }
    await check('Общая блокировка копий возвращает 409 без потери существующего дампа',async()=>{
        const before=files();const rows=await list();node("const fs=require('fs');fs.mkdirSync('/app/backups/.neurocenter-backup.lock',{mode:448});fs.writeFileSync('/app/backups/.neurocenter-backup.lock/owner','fixture',{mode:384});");
        try{const reply=await request(route,{method:'POST',body:{}});assert.equal(reply.status,409);assert.equal(reply.data.code,'BACKUP_BUSY');assert.equal((await request('/api/maintenance/backup',{method:'POST',body:{}})).status,409);assert.deepEqual(await list(),rows);}
        finally{node("require('fs').rmSync('/app/backups/.neurocenter-backup.lock',{recursive:true});");}assert.deepEqual(files(),before);
    });
    await check('Отказ файловой системы при чтении списка даёт 503 вместо ложного отсутствия копий',async()=>{
        const before=files();const rows=await list();const file=before.find(item=>item.file.startsWith('/app/backups/projects/')).file;const directory=file.slice(0,file.lastIndexOf('/'));
        node(`const fs=require('fs'),directory=${JSON.stringify(directory)};fs.renameSync(directory,directory+'.fixture-saved');fs.symlinkSync(directory,directory);`);
        try{const response=await request(route);assert.equal(response.status,503,JSON.stringify(response.data));assert.equal(response.data.code,'BACKUP_STORAGE_UNAVAILABLE');}
        finally{node(`const fs=require('fs'),directory=${JSON.stringify(directory)};fs.unlinkSync(directory);fs.renameSync(directory+'.fixture-saved',directory);`);}
        assert.deepEqual(files(),before);assert.deepEqual(await list(),rows);
    });
    await check('SIGTERM отменяет ожидающий pg_dump ролью без superuser и сохраняет старую копию',async()=>{
        assert.match(database,/^nc_rag_[a-f0-9]{32}$/);const before=files();const rows=await list();
        const blocker=dockerAsync(['exec','-T','postgres','psql','-U','nc_owner','-d',database,'-v','ON_ERROR_STOP=1','-c',"SET application_name='fixture-backup-blocker'; BEGIN; LOCK TABLE rag_chunks IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60); COMMIT;"]).catch(()=>undefined);
        const waitFor=async sql=>{for(let index=0;index<10;index++){if(query('postgres',sql)==='1'){return;}await new Promise(resolve=>setTimeout(resolve,100));}assert.fail('Проверочный PG-процесс не достиг ожидаемого состояния');};
        try{
            await waitFor("SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name='fixture-backup-blocker' AND l.mode='AccessExclusiveLock' AND l.granted");
            const pending=request(route,{method:'POST',body:{}}).catch(()=>null);
            await waitFor("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'nc-backup-%' AND wait_event_type='Lock'");
            await dockerAsync(['stop','--timeout','10','catalog-service']);const interrupted=await pending;assert.ok(!interrupted||[502,503].includes(interrupted.status),JSON.stringify(interrupted));
            assert.equal(query('postgres',"SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'nc-backup-%'"),'0');
        }finally{
            query('postgres',"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='fixture-backup-blocker'");await blocker;
            await dockerAsync(['start','--wait','catalog-service']);
        }
        assert.deepEqual(files(),before);assert.deepEqual(await list(),rows);
    });
    await check('Превышение размера дампа даёт 507, завершает PG-процесс и удаляет partial',async()=>{
        const before=files();const rows=await list();await withPolicy({BACKUP_MAX_FILE_BYTES:128,BACKUP_MAX_TOTAL_BYTES:1048576,BACKUP_MIN_FREE_BYTES:1},async()=>{await denied(507,'BACKUP_QUOTA_EXCEEDED',before);assert.deepEqual(await list(),rows);});
    });
    await check('Резерв свободного диска проверяется до запуска pg_dump',async()=>{
        const before=files();await withPolicy({BACKUP_MIN_FREE_BYTES:Number.MAX_SAFE_INTEGER},()=>denied(507,'BACKUP_DISK_FULL',before));
    });
    await check('Ошибка подтверждения сохраняет новый файл и все прежние копии',async()=>{
        const before=files();const rows=await list();
        query('catalog',"CREATE FUNCTION fixture_backup_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture'; END$$; CREATE TRIGGER fixture_backup_failure BEFORE INSERT ON project_backups FOR EACH STATEMENT EXECUTE FUNCTION fixture_backup_failure();");
        try{
            const reply=await request(route,{method:'POST',body:{}});assert.equal(reply.status,503,JSON.stringify(reply.data));assert.equal(reply.data.code,'BACKUP_CONFIRMATION_FAILED');assert.deepEqual(await list(),rows);
            const after=files();assert.equal(after.length,before.length+1);for(const item of before){assert.deepEqual(after.find(other=>other.file===item.file),item);}assert.ok(after.every(item=>item.file.endsWith('.dump')&&item.mode===0o600));
        }finally{query('catalog','DROP TRIGGER fixture_backup_failure ON project_backups; DROP FUNCTION fixture_backup_failure();');}
    });
    await check('Общий лимит считает также файлы вне каталога метаданных и других проектов',async()=>{
        node("const fs=require('fs');fs.mkdirSync('/app/backups/fixture-unregistered',{mode:448});fs.writeFileSync('/app/backups/fixture-unregistered/retained.data',Buffer.alloc(1048576),{mode:384});");
        try{const before=files();await withPolicy({BACKUP_MAX_TOTAL_BYTES:1048576,BACKUP_MAX_FILE_BYTES:1048576},()=>denied(507,'BACKUP_QUOTA_EXCEEDED',before));}
        finally{node("require('fs').rmSync('/app/backups/fixture-unregistered',{recursive:true});");}
    });
    await check('После семи новых копий остаются пять файлов и пять совпадающих записей',async()=>{
        let latest;
        for(let index=0;index<7;index++){const reply=await request(route,{method:'POST',body:{}});assert.equal(reply.status,201,JSON.stringify(reply.data));latest=reply.data;}
        const rows=await list();assert.equal(rows.length,5);assert.ok(rows.some(row=>row.id===latest.id));assert.equal(files().length,5);
        assert.equal(query('catalog',"SELECT count(*) FROM project_backups WHERE project_id='"+projectId+"'"),'5');
        assert.deepEqual(rows.map(row=>row.fileName).sort(),files().map(row=>row.file.split('/').at(-1)).sort());
    });
    await check('Системный каталог публикуется отдельно и подтверждает дату без изменения копий проекта',async()=>{
        const before=files();const rows=await list();const reply=await request('/api/maintenance/backup',{method:'POST',body:{}});
        assert.equal(reply.status,201,JSON.stringify(reply.data));assert.equal(reply.data.errors.length,0);assert.equal(reply.data.files.length,1);assert.equal(reply.data.files[0].label,'lancedb');
        const after=files();assert.equal(after.length,before.length+1);for(const item of before){assert.deepEqual(after.find(other=>other.file===item.file),item);}assert.deepEqual(await list(),rows);
        const status=await request('/api/maintenance/backup');assert.equal(status.status,200);assert.ok(status.data.lastBackupAt);assert.ok(after.every(item=>item.mode===0o600));
    });
}
