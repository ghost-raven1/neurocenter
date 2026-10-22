import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';

const wait=async(check:()=>Promise<boolean>,timeout=7000)=>{const until=Date.now()+timeout;while(!await check()){if(Date.now()>until)throw Error('Owned process boundary timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
const exists=async(filename:string)=>!!await fs.stat(filename).catch(()=>undefined);
describe.skipIf(process.platform==='win32')('Actual passive supervisor and descendant reaping',()=>{
    let root:string,stage:string,nonce:string,supervisor:string,writer:string;
    const parents:Array<{child:ChildProcess;closed:Promise<void>}> = [];
    beforeEach(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-supervisor-'));stage=path.join(root,randomUUID());await fs.mkdir(stage);nonce=randomUUID();
        for(const name of ['build-supervisor','build-guardian','windows-build-process','build-cleanup']){
            const source=await fs.readFile(path.resolve('src/package-build/'+name+'.ts'),'utf8');
            const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
            await fs.writeFile(path.join(root,name+'.js'),output);
        }
        supervisor=path.join(root,'build-supervisor.js');writer=path.join(root,'writer.cjs');
        const descendant=`const fs=require('node:fs');setInterval(()=>fs.appendFileSync('descendant.log','x'),20);`;
        await fs.writeFile(writer,`const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify({builder:process.pid,descendant:child.pid}));setInterval(()=>fs.appendFileSync('writer.log','x'),20);`);
    });
    afterEach(async()=>{
        for(const parent of parents.splice(0)){if(parent.child.exitCode===null&&parent.child.signalCode===null)parent.child.kill('SIGKILL');await parent.closed;}
        await fs.rm(root,{recursive:true,force:true});
    });
    const parent=()=>{
        const program=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,process.argv.slice(1),{cwd:process.cwd(),detached:true,stdio:['ignore','ignore','ignore','ipc']});process.send({type:'supervisor',pid:child.pid});child.on('message',m=>{if(m.type==='ready')process.send({type:'ready'});});process.on('message',m=>{if(child.connected)child.send(m);});child.once('close',(code)=>{process.exitCode=code||0;if(process.connected)process.disconnect();});`;
        const child=spawn(process.execPath,['-e',program,supervisor,writer,nonce],{cwd:stage,stdio:['ignore','ignore','ignore','ipc']});
        let supervisorPid:number|undefined;child.on('message',message=>{if((message as {type?:string}).type==='supervisor')supervisorPid=(message as {pid:number}).pid;});
        const ready=new Promise<void>(resolve=>child.on('message',message=>{if((message as {type?:string}).type==='ready')resolve();}));
        const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));parents.push({child,closed});return{child,ready,closed,supervisorPid:()=>supervisorPid};
    };
    const proof=()=>path.join(root,'.process-reaped',path.basename(stage)+'.'+nonce+'.json');
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
        await p.closed;await wait(()=>exists(proof()));
        expect(JSON.parse(await fs.readFile(proof(),'utf8'))).toMatchObject({nonce,reaped:true,builderPid:pids.builder});
        const before=await Promise.all(['writer.log','descendant.log'].map(name=>fs.readFile(path.join(stage,name),'utf8')));
        await new Promise(resolve=>setTimeout(resolve,100));expect(await Promise.all(['writer.log','descendant.log'].map(name=>fs.readFile(path.join(stage,name),'utf8')))).toEqual(before);
        for(const pid of [pids.builder,pids.descendant])expect(()=>process.kill(pid,0)).toThrow();
        await wait(async()=>{try{process.kill(p.supervisorPid()!,0);return false;}catch{return true;}});
    },10000);
});
