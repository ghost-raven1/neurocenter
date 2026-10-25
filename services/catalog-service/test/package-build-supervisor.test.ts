import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';

const wait=async(check:()=>Promise<boolean>,timeout=7000,diagnose?:()=>Promise<unknown>)=>{const until=Date.now()+timeout;while(!await check()){if(Date.now()>until)throw Error('Owned process boundary timed out'+(diagnose?' '+JSON.stringify(await diagnose()):''));await new Promise(resolve=>setTimeout(resolve,20));}};
const exists=async(filename:string)=>!!await fs.stat(filename).catch(()=>undefined);
describe.skipIf(process.platform==='win32')('Actual passive supervisor and descendant reaping',()=>{
    let root:string,stage:string,nonce:string,supervisor:string,writer:string;
    type Fault='ipc-close'|'group-unconfirmed'|'signal-absent'|'signal-denied'|'signal-present';
    const parents:Array<{child:ChildProcess;closed:Promise<void>}> = [];
    beforeEach(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-supervisor-'));stage=path.join(root,randomUUID());await fs.mkdir(stage);nonce=randomUUID();
        for(const name of ['build-supervisor','build-guardian','windows-build-process','build-cleanup']){
            const source=await fs.readFile(path.resolve('src/package-build/'+name+'.ts'),'utf8');
            const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
            await fs.writeFile(path.join(root,name+'.js'),output);
        }
        supervisor=path.join(root,'build-supervisor.js');writer=path.join(root,'writer.cjs');
        await fs.writeFile(path.join(root,'ipc-close.cjs'),`const send=process.send;process.send=function(message,...args){if(message.type==='reaped'&&process.connected)process.disconnect();return Reflect.apply(send,process,[message,...args]);};`);
        await fs.writeFile(path.join(root,'group-unconfirmed.cjs'),`const kill=process.kill;process.kill=function(pid,signal){if(pid<0&&signal===0)return true;return Reflect.apply(kill,process,[pid,signal]);};`);
        for(const [name,code] of [['signal-absent','ESRCH'],['signal-denied','EPERM'],['signal-present','PRESENT']])await fs.writeFile(path.join(root,name+'.cjs'),`const kill=process.kill;let signals=0;process.kill=function(pid,signal){if(pid<0&&signal==='SIGKILL'&&++signals>1)throw Object.assign(Error('Controlled signal refusal'),{code:'EPERM'});if(pid<0&&signal===0&&signals>1){if(${JSON.stringify(code)}==='PRESENT')return true;throw Object.assign(Error('Controlled group observation'),{code:${JSON.stringify(code)}});}return Reflect.apply(kill,process,[pid,signal]);};`);
        const descendant=`const fs=require('node:fs');setInterval(()=>fs.appendFileSync('descendant.log','x'),20);`;
        await fs.writeFile(writer,`const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify({builder:process.pid,descendant:child.pid}));setInterval(()=>fs.appendFileSync('writer.log','x'),20);`);
    });
    afterEach(async()=>{
        for(const parent of parents.splice(0)){if(parent.child.exitCode===null&&parent.child.signalCode===null)parent.child.kill('SIGKILL');await parent.closed;}
        await fs.rm(root,{recursive:true,force:true});
    });
    const parent=(fault?:Fault)=>{
        const program=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,process.argv.slice(1),{cwd:process.cwd(),detached:true,stdio:['ignore','ignore','ignore','ipc']});process.send({type:'supervisor',pid:child.pid});child.on('message',m=>{if(m.type==='ready')process.send({type:'ready'});});process.on('message',m=>{if(child.connected)child.send(m);});child.once('close',(code)=>{process.exitCode=code||0;if(process.connected)process.disconnect();});`;
        const child=spawn(process.execPath,['-e',program,'--',...(fault?['--require',path.join(root,fault+'.cjs')]:[]),supervisor,writer,nonce],{cwd:stage,stdio:['ignore','ignore','ignore','ipc']});
        let supervisorPid:number|undefined;child.on('message',message=>{if((message as {type?:string}).type==='supervisor')supervisorPid=(message as {pid:number}).pid;});
        const ready=new Promise<void>(resolve=>child.on('message',message=>{if((message as {type?:string}).type==='ready')resolve();}));
        const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));parents.push({child,closed});return{child,ready,closed,supervisorPid:()=>supervisorPid};
    };
    const proof=()=>path.join(root,'.process-reaped',path.basename(stage)+'.'+nonce+'.json');
    const failure=()=>path.join(root,'.process-reap-failures',path.basename(stage)+'.'+nonce+'.json');
    /** Only this fixture's numeric PIDs and bounded failure codes survive a missing proof. */
    const boundary=async(p:ReturnType<typeof parent>)=>{
        const recorded=JSON.parse(await fs.readFile(path.join(stage,'pids.json'),'utf8').catch(()=>'{}')) as {builder?:number;descendant?:number};
        const probe=async(pid:number|undefined)=>{
            if(!pid)return {state:'not-recorded'};
            try{const {stdout}=await promisify(execFile)('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,stat='],{timeout:1000,maxBuffer:4096});
                const match=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<>NWsLXs]+)/.exec(stdout);
                return match?{pid:Number(match[1]),ppid:Number(match[2]),pgid:Number(match[3]),state:match[4]}:{pid,state:'not-found'};
            }catch(error){return {pid,state:'unavailable',code:(error as NodeJS.ErrnoException).code};}
        };
        const report=JSON.parse(await fs.readFile(failure(),'utf8').catch(()=>'null')) as {code?:string;phase?:string;builderPid?:number;groupProbeCode?:string}|null;
        return {boundary:'durable-reap-proof',nonce,parentSignal:p.child.signalCode,
            processes:await Promise.all([p.supervisorPid(),recorded.builder,recorded.descendant].map(probe)),
            failure:report?{code:report.code,phase:report.phase,builderPid:report.builderPid,groupProbeCode:report.groupProbeCode}:null};
    };
    it('Never starts a builder before START and can cancel its passive state',async()=>{
        const p=parent();await p.ready;await new Promise(resolve=>setTimeout(resolve,60));expect(await fs.readdir(stage)).toEqual([]);
        p.child.send({type:'cancel'});await p.closed;expect(await exists(path.join(stage,'pids.json'))).toBe(false);
        expect(JSON.parse(await fs.readFile(proof(),'utf8'))).toMatchObject({nonce,reaped:true,builderPid:null});
    },10000);
    it.each(['cancel','parent-sigkill'])('Stops actual builder and descendant writer after %s before recording a reap proof',async mode=>{
        const p=parent();await p.ready;p.child.send({type:'start'});
        await wait(async()=>await exists(path.join(stage,'writer.log'))&&await exists(path.join(stage,'descendant.log')));
        const pids=JSON.parse(await fs.readFile(path.join(stage,'pids.json'),'utf8')) as {builder:number;descendant:number};
        if(mode==='cancel')p.child.send({type:'cancel'});else p.child.kill('SIGKILL');
        await p.closed;await wait(()=>exists(proof()),7000,()=>boundary(p));
        expect(JSON.parse(await fs.readFile(proof(),'utf8'))).toMatchObject({nonce,reaped:true,builderPid:pids.builder});
        const before=await Promise.all(['writer.log','descendant.log'].map(name=>fs.readFile(path.join(stage,name),'utf8')));
        await new Promise(resolve=>setTimeout(resolve,100));expect(await Promise.all(['writer.log','descendant.log'].map(name=>fs.readFile(path.join(stage,name),'utf8')))).toEqual(before);
        for(const pid of [pids.builder,pids.descendant])expect(()=>process.kill(pid,0)).toThrow();
        await wait(async()=>{try{process.kill(p.supervisorPid()!,0);return false;}catch{return true;}});
    },10000);
    it('Commits the durable proof when owner IPC disappears exactly at the reap notification',async()=>{
        const p=parent('ipc-close');await p.ready;p.child.send({type:'start'});
        await wait(()=>exists(path.join(stage,'descendant.log')));p.child.send({type:'cancel'});await p.closed;
        await wait(()=>exists(proof()),7000,()=>boundary(p));
        expect(JSON.parse(await fs.readFile(proof(),'utf8'))).toMatchObject({nonce,reaped:true});
    },10000);
    it.each([['signal-absent',true,'ESRCH'],['signal-denied',false,'EPERM'],['signal-present',false,'PRESENT']] as const)('Requires independent ESRCH after signal EPERM: %s',async(fault,confirmed,probeCode)=>{
        const p=parent(fault);await p.ready;p.child.send({type:'start'});
        await wait(()=>exists(path.join(stage,'descendant.log')));p.child.send({type:'cancel'});await p.closed;
        expect(await exists(proof())).toBe(confirmed);
        if(confirmed)expect(JSON.parse(await fs.readFile(proof(),'utf8'))).toMatchObject({nonce,reaped:true,signalErrorCode:'EPERM',groupProbeCode:'ESRCH'});
        else expect(JSON.parse(await fs.readFile(failure(),'utf8'))).toMatchObject({nonce,reaped:false,phase:'terminate',code:'EPERM',groupProbeCode:probeCode});
    },10000);
    it('Retains a negative lifecycle receipt instead of acknowledging an unconfirmed group',async()=>{
        const p=parent('group-unconfirmed');await p.ready;p.child.send({type:'start'});
        await wait(()=>exists(path.join(stage,'descendant.log')));p.child.send({type:'cancel'});await p.closed;
        expect(await exists(proof())).toBe(false);
        expect(JSON.parse(await fs.readFile(failure(),'utf8'))).toMatchObject({nonce,reaped:false,phase:'reap',code:'BUILD_GROUP_NOT_REAPED'});
    },10000);
});
