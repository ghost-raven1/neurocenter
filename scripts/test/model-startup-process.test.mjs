import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runModelStartupProcess} from '../models/startup-process.mjs';

const node=(source,options)=>runModelStartupProcess(process.execPath,['-e',source],{encoding:'utf8',...options});
const listeners=()=>['SIGINT','SIGTERM'].map(signal=>process.listeners(signal));

test('Ожидание процесса не блокирует heartbeat и возвращает поздний вывод',async()=>{
    const ticks=[],before=listeners();
    const result=await node("setTimeout(()=>{console.log('готово');console.error('диагностика');},100)",
        {heartbeatInterval:10,onTick:elapsed=>ticks.push(elapsed),timeout:2000});
    assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal(result.error,undefined);
    assert.equal(result.stdout,'готово\n');assert.equal(result.stderr,'диагностика\n');
    assert.ok(ticks.length>=2);assert.ok(ticks.every((value,index)=>value>0&&(!index||value>=ticks[index-1])));
    assert.deepEqual(listeners(),before);const count=ticks.length;
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(ticks.length,count);
});

test('Игнорирование SIGTERM не превращает deadline в бесконечное ожидание',{timeout:3000},async()=>{
    const before=listeners(),started=Date.now();
    const result=await node("process.on('SIGTERM',()=>{});console.log('готов');setInterval(()=>{},1000)",
        {timeout:500,killGraceMs:30,heartbeatInterval:10});
    assert.equal(result.error?.code,'ETIMEDOUT');assert.equal(result.status,null);assert.equal(result.signal,'SIGKILL');
    assert.match(result.stdout,/готов/);assert.ok(Date.now()-started<2000);assert.deepEqual(listeners(),before);
});

test('Превышение общего лимита stdout и stderr останавливает только свой процесс',{timeout:3000},async()=>{
    const result=await node("process.stdout.write('a'.repeat(50));process.stderr.write('b'.repeat(50));setInterval(()=>{},1000)",
        {maxBuffer:64,timeout:2000,killGraceMs:20});
    assert.equal(result.error?.code,'ENOBUFS');
    assert.ok(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<=64);
});

test('Отсутствующая команда возвращает структурированную ошибку и снимает listeners',async()=>{
    const before=listeners();
    const result=await runModelStartupProcess(path.join(tmpdir(),'nc-missing-model-command-'+process.pid),[],{encoding:'utf8',timeout:100});
    assert.equal(result.error?.code,'ENOENT');assert.equal(result.status,null);assert.deepEqual(listeners(),before);
});

test('Унаследованный stderr не захватывается и не смешивается с JSON stdout',async()=>{
    const result=await node("console.log('{\"ok\":true}')",{stdio:['ignore','pipe','inherit']});
    assert.deepEqual(JSON.parse(result.stdout),{ok:true});assert.equal(result.stderr,null);
});

for(const signal of ['SIGINT','SIGTERM'])test(`Отмена ${signal} завершает ребёнка и восстанавливает обработчики`,{timeout:3000},async()=>{
    const before=listeners();let cancelled=false;
    const result=await node("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",{
        timeout:2000,killGraceMs:20,heartbeatInterval:10,onTick:()=>{
            if(!cancelled) {cancelled=true;process.emit(signal);}
        }});
    assert.equal(result.error?.code,'ECANCELED');assert.equal(result.signal,signal);assert.deepEqual(listeners(),before);
});

test('Deadline убирает потомка своей группы и не затрагивает соседний процесс',{skip:process.platform==='win32',timeout:5000},async t=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-model-process-')),filename=path.join(directory,'descendant.pid');
    const neighbour=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
    let descendant;
    t.after(async()=>{
        for(const pid of [neighbour.pid,descendant])if(pid)try {process.kill(pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH')throw error;}
        await rm(directory,{recursive:true,force:true});
    });
    const source=`const {spawn}=require('node:child_process'),fs=require('node:fs');
        const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
        fs.writeFileSync(${JSON.stringify(filename)},String(child.pid));
        process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const result=await node(source,{timeout:500,killGraceMs:30});
    descendant=Number(await readFile(filename,'utf8'));
    assert.equal(result.error?.code,'ETIMEDOUT');assert.doesNotThrow(()=>process.kill(neighbour.pid,0));
    // После SIGKILL процесс может кратко оставаться zombie до reap ОС; исполняемого процесса быть не должно.
    const check=await runModelStartupProcess('ps',['-p',String(descendant),'-o','stat='],{encoding:'utf8',timeout:1000});
    assert.ok(check.status!==0||check.stdout.trim().startsWith('Z'),check.stdout);
});
