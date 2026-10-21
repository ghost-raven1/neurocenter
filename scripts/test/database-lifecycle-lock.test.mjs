import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {databaseLifecycleLock} from '../production/database-lifecycle-lock.mjs';

function fixture({deny=false}={}){
    const child=new EventEmitter(),commands=[];child.stdout=new PassThrough();child.stderr=new PassThrough();let closed=false;
    const close=()=>{if(!closed){closed=true;child.emit('close',0);}};
    child.kill=close;child.stdin=new Writable({write(chunk,_encoding,callback){const sql=String(chunk);commands.push(sql);queueMicrotask(()=>{
        if(sql.includes('pg_try_advisory_lock')){if(deny)close();else child.stdout.write('SET\nDO\nNC_LIFECYCLE_LOCKED\n');}
        if(sql.includes('\\q'))close();});callback();}});
    let args;return {child,commands,close,spawnProcess:(...value)=>{args=value;return child;},args:()=>args};
}
test('Backup lifecycle fence owns one exact rag PG session with a nontruncated safe application name',async()=>{
    const f=fixture(),lease=await databaseLifecycleLock('own-postgres',{spawnProcess:f.spawnProcess});lease.assertHeld();
    assert.ok(Buffer.byteLength(lease.applicationName)<64);assert.ok(f.commands[0].includes(lease.applicationName));assert.ok(f.commands[0].includes("hashtextextended('neurocenter:database-lifecycle',0)"));
    assert.deepEqual(f.args()[1].slice(0,4),['exec','-i','own-postgres','psql']);assert.equal(f.args()[1][f.args()[1].indexOf('-d')+1],'rag');
    await lease.close();await lease.close();assert.throws(()=>lease.assertHeld(),/потеряна/);assert.equal(f.commands.filter(sql=>sql.includes('pg_advisory_unlock')).length,1);
});
test('A lost PG session invalidates the lease and cannot produce a confirmed backup receipt',async()=>{
    const f=fixture(),lease=await databaseLifecycleLock('own-postgres',{spawnProcess:f.spawnProcess});f.close();assert.throws(()=>lease.assertHeld(),/копия не подтверждена/);await lease.close();
});
test('Busy lifecycle fence refuses before applications are paused; no stale lock is removed',async()=>{
    const f=fixture({deny:true});await assert.rejects(databaseLifecycleLock('own-postgres',{spawnProcess:f.spawnProcess}),/прервана/);assert.equal(f.commands.length,1);assert.ok(!f.commands[0].includes('pg_terminate_backend'));
});
test('Untrusted container identity cannot become a Docker option or SQL input',async()=>{
    for(const container of ['--privileged','own;sql','own\ncontainer',''])await assert.rejects(databaseLifecycleLock(container,{spawnProcess:()=>{throw Error('must not spawn');}}),/Некорректный/);
});
