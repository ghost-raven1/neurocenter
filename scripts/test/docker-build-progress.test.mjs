import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const helper=new URL('../workspace/docker-build-progress.mjs',import.meta.url);

/** Drive the real progress supervisor with an observed child, without Docker or wall-clock waits. */
async function fixture(t,{throwError,buildkit}={}){
    const {runDockerBuild}=await import(helper.href),originalSpawn=childProcess.spawn,originalLog=console.log;
    const child=new EventEmitter(),calls=[],logs=[],signals=[];
    child.kill=signal=>{signals.push(signal);return true;};
    childProcess.spawn=(...args)=>{calls.push(args);if(throwError)throw throwError;return child;};
    console.log=(...args)=>logs.push(args.join(' '));syncBuiltinESMExports();
    t.after(()=>{childProcess.spawn=originalSpawn;console.log=originalLog;syncBuiltinESMExports();});
    t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:0});
    const before={SIGINT:process.listenerCount('SIGINT'),SIGTERM:process.listenerCount('SIGTERM')};
    const environment={PATH:'/owned/no-executables',HTTPS_PROXY:'http://private-user:private-password@proxy.invalid:3128',...(buildkit===undefined?{}:{BUILDKIT_PROGRESS:buildkit})};
    const pending=runDockerBuild(['build','--build-arg','HTTPS_PROXY','.'],{cwd:'/owned/build',env:environment,stdio:'inherit',timeout:600000,killSignal:'SIGKILL'});
    const cleaned=()=>{for(const signal of ['SIGINT','SIGTERM'])assert.equal(process.listenerCount(signal),before[signal]);};
    return{pending,child,calls,logs,signals,environment,cleaned};
}

test('quiet Docker build reports its stage immediately and elapsed wait every fifteen seconds, then clears progress',async t=>{
    const f=await fixture(t);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'docker');
    assert.deepEqual(f.calls[0][1],['build','--build-arg','HTTPS_PROXY','.']);
    const options=f.calls[0][2];assert.equal(options.stdio,'inherit');assert.equal(options.cwd,'/owned/build');assert.equal(options.timeout,600000);assert.equal(options.killSignal,'SIGKILL');
    assert.equal(options.env.BUILDKIT_PROGRESS,'plain');assert.equal(f.environment.BUILDKIT_PROGRESS,undefined);
    assert.equal(f.logs.length,1);assert.match(f.logs[0],/сборк|build/iu);
    t.mock.timers.tick(14999);assert.equal(f.logs.length,1);t.mock.timers.tick(1);assert.equal(f.logs.length,2);assert.match(f.logs[1],/15/);assert.match(f.logs[1],/600/);
    t.mock.timers.tick(15000);assert.equal(f.logs.length,3);assert.match(f.logs[2],/30/);
    f.child.emit('close',0,null);const result=await f.pending;assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal(result.error,undefined);
    const count=f.logs.length;t.mock.timers.tick(600000);assert.equal(f.logs.length,count);assert.deepEqual(f.signals,[]);f.cleaned();
    assert.ok(f.logs.every(line=>!line.includes('private-password')&&!line.includes('proxy.invalid')&&!/\b\d+%|\b\d+\s*(?:MB|MiB|КБ|МБ)\b/.test(line)));
});

test('Docker progress preserves an explicitly selected BuildKit display',async t=>{
    const f=await fixture(t,{buildkit:'tty'});assert.equal(f.calls[0][2].env.BUILDKIT_PROGRESS,'tty');f.child.emit('close',0,null);await f.pending;f.cleaned();
});

for(const [code,signal]of [[37,null],[null,'SIGTERM']])test('Docker progress keeps the exact child outcome '+String(code??signal),async t=>{
    const f=await fixture(t);f.child.emit('close',code,signal);const result=await f.pending;
    assert.equal(result.status,code);assert.equal(result.signal,signal);assert.equal(result.error,undefined);f.cleaned();
});

test('Docker spawn errors retain identity but still await close and remove progress handlers',async t=>{
    const f=await fixture(t),error=Object.assign(Error('private command text'),{code:'ENOENT'});let settled=false;f.pending.then(()=>{settled=true;});
    f.child.emit('error',error);await Promise.resolve();assert.equal(settled,false);f.child.emit('close',null,null);
    const result=await f.pending;assert.equal(result.error,error);assert.ok(f.logs.every(line=>!line.includes(error.message)));f.cleaned();
});

test('synchronous spawn errors clean progress and cancellation handlers',async t=>{
    const error=Object.assign(Error('private command text'),{code:'EINVAL'}),f=await fixture(t,{throwError:error});
    const result=await f.pending;assert.equal(result.error,error);const count=f.logs.length;t.mock.timers.tick(600000);assert.equal(f.logs.length,count);f.cleaned();
});

/** The executable called docker belongs to this fixture; only its owned Node process is started. */
async function nativeFixture(t,timeout){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-docker-progress-'));
    const pidFile=path.join(directory,'pid'),probe=path.join(directory,'probe-'+randomUUID()+'.cjs'),driver=path.join(directory,'driver.mjs');
    await fs.writeFile(path.join(directory,'docker'),'#!/bin/sh\nexec "$PROGRESS_TEST_NODE" "$PROGRESS_TEST_SCRIPT" "$@"\n',{mode:0o700});
    await fs.writeFile(probe,"require('node:fs').writeFileSync(process.env.PROGRESS_TEST_PID,String(process.pid));process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('OWNED_DOCKER_LAYER 20MB/40MB');console.error('npm http fetch PENDING_FIXTURE');setInterval(()=>{},1000);\n");
    const environment={PATH:directory,PROGRESS_TEST_NODE:process.execPath,PROGRESS_TEST_SCRIPT:probe,PROGRESS_TEST_PID:pidFile};
    await fs.writeFile(driver,`import {runDockerBuild} from ${JSON.stringify(helper.href)};const value=await runDockerBuild(['build','.'],{cwd:${JSON.stringify(directory)},env:${JSON.stringify(environment)},stdio:'inherit',timeout:${timeout},killSignal:'SIGKILL'});console.log('RESULT='+JSON.stringify({status:value.status,signal:value.signal,errorCode:value.error?.code}));\n`);
    const launched=Date.now(),child=childProcess.spawn(process.execPath,[driver],{stdio:['ignore','pipe','pipe'],env:{},timeout:5000,killSignal:'SIGKILL'});let stdout='',stderr='',closed=false,owned,reaped=false;
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
    const identity=pid=>{
        let value;try{value=childProcess.execFileSync('/bin/ps',['-ww','-p',String(pid),'-o','lstart=,args='],{encoding:'utf8',timeout:1000,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC'},stdio:['ignore','pipe','pipe']}).trim();}
        catch(error){if(error.status===1)return null;throw error;}
        const match=/^(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(value),birth=match?Date.parse(match[1]+' UTC'):NaN;
        assert.ok(match&&match[2].split(/\s+/).includes(probe)&&Number.isFinite(birth)&&birth>=launched-2000&&birth<=Date.now()+2000,'cleanup ownership of UUID probe could not be established');
        return value;
    };
    const ready=async()=>{await new Promise((resolve,reject)=>{
        const check=()=>{if(stdout.includes('OWNED_DOCKER_LAYER')&&stderr.includes('PENDING_FIXTURE')){clean();resolve();}};
        const fail=()=>{clean();reject(Error('owned Docker probe exited before live output: '+stdout+stderr));};
        const clean=()=>{child.stdout.off('data',check);child.stderr.off('data',check);child.off('close',fail);};
        child.stdout.on('data',check);child.stderr.on('data',check);child.once('close',fail);check();
    });const pid=Number(await fs.readFile(pidFile,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);owned={pid,identity:identity(pid)};assert.ok(owned.identity,'owned probe exited before observation');};
    const assertReaped=async()=>{const pid=owned?.pid??Number(await fs.readFile(pidFile,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});reaped=true;};
    t.after(async()=>{try{
        if(!closed)child.kill('SIGKILL');await finished;
        if(!reaped)try{
            const pid=owned?.pid??Number(await fs.readFile(pidFile,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);
            const current=identity(pid);if(current){if(owned)assert.equal(current,owned.identity,'UUID probe birth identity changed');assert.equal(identity(pid),current,'UUID probe identity changed before cleanup');process.kill(pid,'SIGKILL');}
        }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
    }finally{await fs.rm(directory,{recursive:true,force:true});}});
    return{child,finished,ready,reaped:assertReaped,output:()=>({stdout,stderr}),isClosed:()=>closed};
}

test('native Docker timeout keeps live output, kills and reaps the owned CLI with ETIMEDOUT',async t=>{
    await import(helper.href);const f=await nativeFixture(t,1200);await f.ready();assert.equal(f.isClosed(),false);
    const finished=await f.finished;assert.equal(finished.code,0);assert.equal(finished.signal,null);await f.reaped();
    const {stdout,stderr}=f.output(),result=JSON.parse(stdout.match(/^RESULT=(.+)$/m)[1]);
    assert.equal(result.status,null);assert.equal(result.signal,'SIGKILL');assert.equal(result.errorCode,'ETIMEDOUT');assert.match(stderr,/npm http fetch PENDING_FIXTURE/);
});

for(const signal of ['SIGINT','SIGTERM'])test('native '+signal+' cancellation reaps an owned Docker CLI that ignores graceful signals',async t=>{
    await import(helper.href);const f=await nativeFixture(t,60000);await f.ready();assert.equal(f.isClosed(),false);f.child.kill(signal);
    const finished=await f.finished;assert.equal(finished.code,0);assert.equal(finished.signal,null);await f.reaped();
    const result=JSON.parse(f.output().stdout.match(/^RESULT=(.+)$/m)[1]);assert.equal(result.status,null);assert.equal(result.signal,'SIGKILL');assert.equal(result.errorCode,undefined);
});
