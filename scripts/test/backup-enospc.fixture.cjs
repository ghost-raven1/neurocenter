const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const processTools=require('node:child_process');

/** Только фикстура: занимает tmpfs между statfs и write, воспроизводя внешнего писателя. */
async function main(){
    const root='/fixture-backups';const payload=Buffer.concat([Buffer.from('PGDMP'),Buffer.alloc(8192,42)]);let killed=0;
    processTools.spawn=()=>{
        const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{killed++;child.stdout.destroy();queueMicrotask(()=>child.emit('close',143));return true;}});
        queueMicrotask(()=>{child.stdout.end(payload);child.stderr.end();queueMicrotask(()=>child.emit('close',0));});return child;
    };
    const original=fs.statfs;let calls=0;let fill=true;let actualEnospc=false;
    fs.statfs=async(...args)=>{
        const info=await original(...args);
        if(fill&&++calls===2){fill=false;await fs.writeFile(path.join(root,'external-writer'),Buffer.alloc(Number(info.bavail*info.bsize)));}
        return info;
    };
    // Наблюдаем errno настоящего write; возвращаем вызов FileHandle без изменения результата.
    const open=fs.open;fs.open=async(...args)=>{
        const handle=await open(...args);const write=handle.write.bind(handle);
        handle.write=async(...values)=>{try{return await write(...values);}catch(error){if(error.code==='ENOSPC'){actualEnospc=true;}throw error;}};return handle;
    };
    process.env.BACKUP_MIN_FREE_BYTES='1';process.env.BACKUP_MAX_FILE_BYTES='32768';process.env.BACKUP_MAX_TOTAL_BYTES='65536';
    delete process.env.DEV_POSTGRES_CONTAINER;
    const {runAllBackups}=require('/app/dist/catalog/backup');const old='project-20250101-000000000-00000000-0000-0000-0000-000000000000.dump';
    await fs.writeFile(path.join(root,old),'PGDMPсохранённая копия',{mode:0o600});let confirmed=0;
    const options={confirm:async()=>{confirmed++;}};
    await assert.rejects(runAllBackups({project:'postgresql://fixture@localhost/fixture'},root,options),error=>error.getStatus()===507&&error.getResponse().code==='BACKUP_DISK_FULL');
    assert.equal(actualEnospc,true);assert.ok(killed>0);assert.equal(confirmed,0);assert.equal(await fs.readFile(path.join(root,old),'utf8'),'PGDMPсохранённая копия');
    assert.deepEqual((await fs.readdir(root)).sort(),['external-writer',old].sort());
    console.log('OK Настоящий ENOSPC сохраняет старый дамп, удаляет partial и освобождает lock');
    await fs.rm(path.join(root,'external-writer'));fs.statfs=original;
    const saved=await runAllBackups({project:'postgresql://fixture@localhost/fixture'},root,options);
    assert.equal(confirmed,1);assert.deepEqual(await fs.readFile(saved.files[0].file),payload);assert.equal((await fs.stat(saved.files[0].file)).mode&0o777,0o600);
    assert.equal((await fs.readdir(root)).length,2);
    console.log('OK После освобождения места новая копия создаётся и подтверждается');
    console.log(JSON.stringify({passed:2,realEnospc:true,tmpfsBytes:65536,realPgDump:false}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
