import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const workspace=fileURLToPath(new URL('../workspace/',import.meta.url));
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};
async function until(read){for(let index=0;index<300;index++){const value=await read();if(value)return value;await delay(20);}throw Error('Owned fixture did not become ready.');}
/** Each CLI fixture owns its checkout, tiny npm substitute and process groups. */
async function fixture(t,program=''){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'neurocenter check source '))),root=path.join(directory,'checkout');
    await fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true});await fs.mkdir(path.join(root,'frontend'));
    for(const name of await fs.readdir(workspace))if(name.endsWith('.mjs'))await fs.copyFile(path.join(workspace,name),path.join(root,'scripts/workspace',name));
    await fs.writeFile(path.join(root,'frontend/package.json'),JSON.stringify({scripts:{build:'fixture'}}));
    await fs.writeFile(path.join(root,'tracked.txt'),'original');await fs.writeFile(path.join(root,'deleted.txt'),'delete-me');
    await fs.writeFile(path.join(root,'.gitignore'),'.run/\n');
    const npm=path.join(directory,'npm-cli.js');await fs.writeFile(npm,program);
    const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
    git(['init','-q','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']);
    let child;const env={NODE_BIN:process.execPath,NPM_CLI_JS:npm,PATH:path.dirname(process.execPath)+':/usr/bin:/bin'};
    const run=(extraEnv={})=>{child=spawn(process.execPath,[path.join(root,'scripts/workspace/check.mjs'),'--package','frontend','--step','build'],{cwd:root,env:{...env,...extraEnv},detached:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
        const ended=once(child,'exit').then(([code,signal])=>({code,signal,stdout,stderr}));return {child,ended};};
    t.after(async()=>{if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}await fs.rm(directory,{recursive:true,force:true});});
    const report=async()=>{const names=await fs.readdir(path.join(root,'.run/check'));return readJson(path.join(root,'.run/check',names[0],'report.json'));};
    return {directory,root,npm,env,run,report};
}

test('check records current dirty/new/deleted bytes before and after, excluding its generated run',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.root,'tracked.txt'),'dirty');await fs.writeFile(path.join(f.root,'new.txt'),'new');await fs.rm(path.join(f.root,'deleted.txt'));
    const result=await f.run().ended;assert.equal(result.code,0,result.stderr);const report=await f.report();
    assert.equal(report.schemaVersion,3);assert.equal(report.source.status,'unchanged');assert.deepEqual(report.source.before,report.source.after);
    assert.equal(report.source.before.deleted,1);assert.equal(report.source.before.newFiles,1);assert.match(report.source.before.sha256,/^[a-f0-9]{64}$/);
    assert.equal(report.steps[0].cleanup.noLiveDescendants,true);assert.equal(report.steps[0].leaderReaped,true);
    assert.equal(JSON.stringify(report.source).includes('tracked.txt'),false);
});

test('a successful command that edits source is retained as passed command with failed source applicability',async t=>{
    const f=await fixture(t,"require('node:fs').writeFileSync('../tracked.txt','changed-during-check');");
    const result=await f.run().ended;assert.equal(result.code,1,result.stderr);const report=await f.report();
    assert.equal(report.success,false);assert.equal(report.state,'failed');assert.equal(report.failure.code,'SOURCE_CHANGED');assert.equal(report.steps[0].ok,true);
    assert.equal(report.source.status,'changed');assert.notEqual(report.source.before.sha256,report.source.after.sha256);
});

test('a concurrent write detected inside capture fails applicability even when both snapshots are unavailable',async t=>{
    const {runCheck}=await import('../workspace/check.mjs'),f=await fixture(t),target=path.join(f.root,'tracked.txt');
    const open=fs.open;let injections=0;
    fs.open=async(file,...args)=>{
        const handle=await open(file,...args);
        if(file===target){const read=handle.read.bind(handle);let written=false;
            handle.read=async(...options)=>{const result=await read(...options);if(!written){written=true;injections++;await fs.appendFile(target,'concurrent-write');}return result;};}
        return handle;
    };
    const sink={write:()=>{}};let report;
    try{report=await runCheck(f.root,{packages:['frontend'],steps:['build']},{environment:f.env,output:sink,errorOutput:sink});}
    finally{fs.open=open;}
    assert.equal(injections,2);assert.equal(report.steps[0].ok,true);
    assert.equal(report.source.status,'unknown');assert.equal(report.source.reason,'SOURCE_CHANGED');
    assert.equal(report.state,'failed');assert.equal(report.success,false);assert.equal(report.failure.code,'SOURCE_CHANGED');
});

for(const change of ['new test script','metadata with identical step list'])test(`a manifest changed between planning and before capture rejects ${change} before any command`,async t=>{
    const {runCheck}=await import('../workspace/check.mjs'),f=await fixture(t,"require('node:fs').writeFileSync('../.run/command-started','yes');");
    const target=path.join(f.root,'frontend/package.json'),open=fs.open;let changed=false;
    fs.open=async(file,...args)=>{
        if(file===target&&!changed){changed=true;await fs.writeFile(target,JSON.stringify({scripts:{build:'fixture',...(change==='new test script'?{test:'vitest run'}:{})},version:'next'}));}
        return open(file,...args);
    };
    const sink={write:()=>{}};let report;
    try{report=await runCheck(f.root,{packages:['frontend'],steps:[]},{environment:f.env,output:sink,errorOutput:sink});}
    finally{fs.open=open;}
    assert.equal(changed,true);assert.equal(report.state,'failed');assert.equal(report.failure.code,'PLAN_SOURCE_CHANGED');
    assert.deepEqual(report.steps,[]);assert.equal(report.source.status,'unchanged');
    await assert.rejects(fs.stat(path.join(f.root,'.run/command-started')),error=>error.code==='ENOENT');
});

test('source opt-out remains explicit unknown and does not pretend to have source snapshots',async t=>{
    const f=await fixture(t);const result=await f.run({NEUROCENTER_CHECK_SOURCE:'0'}).ended;assert.equal(result.code,0,result.stderr);
    const report=await f.report();assert.equal(report.source.status,'unknown');assert.equal(report.source.reason,'SOURCE_DISABLED');assert.equal(report.source.before,null);assert.equal(report.source.after,null);
});

test('an invalid source flag fails before any runtime command or report directory',async t=>{
    for(const flag of ['false','2','', '01']){
        const f=await fixture(t);const result=await f.run({NEUROCENTER_CHECK_SOURCE:flag}).ended;
        assert.equal(result.code,1);assert.match(result.stderr,/NEUROCENTER_CHECK_SOURCE/);
        await assert.rejects(fs.stat(path.join(f.root,'.run')),error=>error.code==='ENOENT');
    }
});

test('check does not include its new .run files even when .run is not gitignored',async t=>{
    const f=await fixture(t);await fs.rm(path.join(f.root,'.gitignore'));
    const result=await f.run().ended;assert.equal(result.code,0,result.stderr);assert.equal((await f.report()).source.status,'unchanged');
});

test('a Git-less fixture can complete commands while source evidence stays explicitly unknown',async t=>{
    const f=await fixture(t);await fs.rm(path.join(f.root,'.git'),{recursive:true});const result=await f.run().ended;
    assert.equal(result.code,0,result.stderr);const report=await f.report();assert.equal(report.state,'passed');assert.equal(report.source.status,'unknown');assert.equal(report.source.reason,'NOT_GIT_REPOSITORY');
});

const writer=`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.mkdirSync('../.run/writer',{recursive:true});fs.writeFileSync('../.run/writer/ready.json',JSON.stringify({pid:process.pid}));setInterval(()=>fs.appendFileSync('../.run/writer/heartbeat','beat\\n'),10);`;
const compiler=`const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
/** A separate group is deliberately outside the check's ownership and must remain running. */
async function sentinel(t){
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}),exited=once(child,'exit');
    t.after(async()=>{child.kill('SIGTERM');await exited;});return child;
}
async function stoppedWriter(f,pid){
    const file=path.join(f.root,'.run/writer/heartbeat'),before=await fs.readFile(file,'utf8');await delay(120);
    assert.equal(await fs.readFile(file,'utf8'),before);assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
}
for(const signal of ['SIGINT','SIGTERM'])test(`${signal} saves a cancelled terminal report, kills its stubborn descendants and preserves another group`,{skip:process.platform==='win32'},async t=>{
    const f=await fixture(t,compiler),foreign=await sentinel(t),running=f.run();
    const ready=await until(()=>readJson(path.join(f.root,'.run/writer/ready.json')));running.child.kill(signal);
    const result=await running.ended;assert.equal(result.code,signal==='SIGINT'?130:143,result.stderr);const report=await f.report();
    assert.equal(report.state,'cancelled');assert.equal(report.success,false);assert.equal(report.failure.code,'CANCELLED');assert.deepEqual(report.cancellation,{signal});assert.ok(report.finishedAt);
    assert.equal(report.steps.length,1);assert.equal(report.steps[0].leaderReaped,true);assert.equal(report.steps[0].cleanup.noLiveDescendants,true);
    assert.deepEqual(report.steps[0].cleanup.signals,['SIGTERM','SIGKILL']);await stoppedWriter(f,ready.pid);assert.equal(process.kill(foreign.pid,0),true);
});

test('a step timeout finalizes its failure and cleans only the owned child group',{skip:process.platform==='win32'},async t=>{
    const {runCheck}=await import('../workspace/check.mjs'),f=await fixture(t,compiler),foreign=await sentinel(t),controller=new AbortController();
    const sink={write:()=>{}},pending=runCheck(f.root,{packages:['frontend'],steps:['build']},{environment:f.env,signal:controller.signal,timeoutMs:1000,graceMs:80,output:sink,errorOutput:sink});
    t.after(async()=>{controller.abort();await pending;});const ready=await until(()=>readJson(path.join(f.root,'.run/writer/ready.json')));
    const report=await pending;assert.equal(report.state,'failed');assert.equal(report.failure.code,'CHECK_TIMEOUT');assert.equal(report.steps[0].cleanup.noLiveDescendants,true);
    assert.deepEqual(report.steps[0].cleanup.signals,['SIGTERM','SIGKILL']);assert.ok(report.finishedAt);assert.equal((await f.report()).state,'failed');await stoppedWriter(f,ready.pid);assert.equal(process.kill(foreign.pid,0),true);
});
