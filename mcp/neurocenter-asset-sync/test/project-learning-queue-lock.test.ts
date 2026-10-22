import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {withLearningQueueLock} from '../src/features/project-learning/queue-lock.js';

const fixture=fileURLToPath(new URL('./learning-queue-lock.fixture.mjs',import.meta.url));
interface Worker {child:ChildProcess;events:string[];exit:Promise<number|null>;wait:(type:string)=>Promise<void>;errors:()=>string}
describe('Learning queue SQLite commit admission',()=>{
    let directory:string;const children:Worker[]=[];
    beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-queue-commit-'));});
    afterEach(async()=>{vi.restoreAllMocks();for(const worker of children.splice(0)){if(worker.child.exitCode===null&&worker.child.signalCode===null)worker.child.kill('SIGKILL');await worker.exit;}await fs.rm(directory,{recursive:true,force:true});});
    async function worker(mode:string):Promise<Worker>{
        const child=spawn(process.execPath,['--import','tsx',fixture,mode,directory],{stdio:['ignore','pipe','pipe','ipc']});
        const events:string[]=[];let errors='';child.on('message',value=>events.push((value as {type:string}).type));child.stderr!.on('data',value=>{errors+=String(value);});
        const exit=new Promise<number|null>(resolve=>child.once('exit',resolve));
        const wait=async(type:string)=>{const deadline=Date.now()+5000;while(!events.includes(type)){if(child.exitCode!==null||child.signalCode!==null)throw Error(errors);if(Date.now()>deadline)throw Error('No '+type);await new Promise(resolve=>setTimeout(resolve,5));}};
        const result={child,events,exit,wait,errors:()=>errors};children.push(result);await wait('ready');return result;
    }
    it('retries the same real BUSY COMMIT after an independent reader releases, without replaying the action',async()=>{
        let reader:Worker|undefined,busy=0,commits=0,actions=0;const original=DatabaseSync.prototype.exec;
        vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
            if(sql==='COMMIT')commits++;
            try{return original.call(this,sql);}catch(error){if(sql==='COMMIT'&&(error as {errcode?:number}).errcode===5){busy++;reader!.child.send({type:'release'});}throw error;}
        });
        await expect(withLearningQueueLock(directory,async()=>{
            actions++;await fs.appendFile(path.join(directory,'published'),'exact payload\n');reader=await worker('reader');reader.child.send({type:'start'});await reader.wait('reading');return 'receipt';
        })).resolves.toBe('receipt');
        expect(busy).toBeGreaterThanOrEqual(1);expect(commits).toBe(busy+1);expect(actions).toBe(1);expect(await reader!.exit,reader!.errors()).toBe(0);
        expect(await fs.readFile(path.join(directory,'published'),'utf8')).toBe('exact payload\n');
    });
    it('holds the write lock while COMMIT waits and never admits an independent writer early',async()=>{
        let reader:Worker|undefined,contender:Worker|undefined,probe:Promise<void>|undefined,checked=false;const original=DatabaseSync.prototype.exec;
        vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
            try{return original.call(this,sql);}catch(error){if(sql==='COMMIT'&&!checked){checked=true;contender!.child.send({type:'start'});probe=(async()=>{try{await new Promise(resolve=>setTimeout(resolve,75));expect(contender!.events).not.toContain('entered');}finally{reader!.child.send({type:'release'});}})();void probe.catch(()=>undefined);}throw error;}
        });
        try{await withLearningQueueLock(directory,async()=>{contender=await worker('writer');reader=await worker('reader');reader.child.send({type:'start'});await reader.wait('reading');});}finally{await probe;}
        expect(checked).toBe(true);expect(await reader!.exit).toBe(0);expect(await contender!.exit,contender!.errors()).toBe(0);expect(contender!.events).toContain('entered');
    });
    it('ends a real BUSY COMMIT at the existing deadline without replay and releases its own transaction',async()=>{
        let reader:Worker|undefined,expired=false,actions=0,primary:unknown;const now=Date.now(),original=DatabaseSync.prototype.exec;
        vi.spyOn(Date,'now').mockImplementation(()=>now+(expired?5001:0));
        vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){try{return original.call(this,sql);}catch(error){if(sql==='COMMIT'){primary=error;expired=true;}throw error;}});
        const result=withLearningQueueLock(directory,async()=>{actions++;reader=await worker('reader');reader.child.send({type:'start'});await reader.wait('reading');});
        await expect(result).rejects.toSatisfy(error=>error===primary&&(error as {errcode:number}).errcode===5);expect(actions).toBe(1);
        reader!.child.send({type:'release'});expect(await reader!.exit).toBe(0);vi.restoreAllMocks();
        const contender=await worker('writer');contender.child.send({type:'start'});expect(await contender.exit,contender.errors()).toBe(0);
    });
    it('preserves an action failure if ROLLBACK fails and closes the session before another owner',async()=>{
        const primary=Error('action failed'),rollback=Error('rollback unavailable'),original=DatabaseSync.prototype.exec;let rollbacks=0;
        vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(sql==='ROLLBACK'){rollbacks++;throw rollback;}return original.call(this,sql);});
        await expect(withLearningQueueLock(directory,async()=>{throw primary;})).rejects.toBe(primary);expect(rollbacks).toBe(1);
        vi.restoreAllMocks();const contender=await worker('writer');contender.child.send({type:'start'});expect(await contender.exit,contender.errors()).toBe(0);expect(contender.events).toContain('entered');
    });
    it('does not retry a non-BUSY COMMIT failure or repeat the completed action',async()=>{
        const primary=Object.assign(Error('commit unavailable'),{errcode:10}),original=DatabaseSync.prototype.exec;let actions=0,commits=0;
        vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(sql==='COMMIT'){commits++;throw primary;}return original.call(this,sql);});
        await expect(withLearningQueueLock(directory,async()=>{actions++;})).rejects.toBe(primary);expect(actions).toBe(1);expect(commits).toBe(1);
        vi.restoreAllMocks();const contender=await worker('writer');contender.child.send({type:'start'});expect(await contender.exit).toBe(0);
    });
});
