import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {enqueueLearningObservation,LEARNING_QUEUE_LIMIT} from '../src/features/project-learning/observation-queue.js';
import {withLearningQueueLock,LEARNING_QUEUE_MUTEX} from '../src/features/project-learning/queue-lock.js';
import {syncDirectory} from '../src/bridge/atomic-file.js';
import {nativeQueueFixture} from './learning-queue-native.fixture.js';

const fixture=fileURLToPath(new URL('./learning-queue-process.fixture.mjs',import.meta.url));
interface Worker {process:ChildProcess;events:Array<Record<string,unknown>>;exit:Promise<number|null>;wait:(type:string)=>Promise<Record<string,unknown>>;stderr:()=>string}
const observation=()=>({requestKey:randomUUID(),title:'Observed',summary:'Service counters',outcome:'unknown' as const,evidence:[{kind:'observation' as const,status:'unknown' as const,summary:'{"read":1}'}]});
describe('Private queue — actual independent processes and crash recovery',()=>{
    let temporary:string,directory:string;const workers:Worker[]=[];
    const target={projectId:'prj-process-test',bindingId:'a'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111'};
    const bucket=()=>path.join(directory,target.bindingId);
    const records=async()=> (await fs.readdir(bucket())).filter(name=>name.endsWith('.json'));
    function worker(mode:string,where=directory):Worker{
        const process=spawn(globalThis.process.execPath,['--import','tsx',fixture,mode,where,JSON.stringify(target)],{stdio:['ignore','pipe','pipe','ipc']});
        let errors='';const events:Array<Record<string,unknown>>=[];process.stderr!.on('data',chunk=>{errors+=String(chunk);});process.on('message',value=>events.push(value as Record<string,unknown>));
        const exit=new Promise<number|null>(resolve=>process.once('exit',code=>resolve(code)));
        const wait=async(type:string)=>{
            const deadline=Date.now()+10000;while(Date.now()<deadline){const value=events.find(item=>item.type===type);if(value)return value;
                if(process.exitCode!==null||process.signalCode!==null)throw Error('Worker exited before '+type+': '+errors);await new Promise(resolve=>setTimeout(resolve,10));}
            throw Error('Timed out waiting for '+type+': '+errors);
        };
        const result={process,events,exit,wait,stderr:()=>errors};workers.push(result);return result;
    }
    const start=async(mode:string,where=directory)=>{const value=worker(mode,where);await value.wait('ready');value.process.send({type:'start'});return value;};
    beforeEach(async()=>{temporary=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-queue-process-'));directory=path.join(temporary,'queue');await fs.mkdir(directory,{mode:0o700});});
    afterEach(async()=>{vi.restoreAllMocks();for(const value of workers.splice(0)){if(value.process.exitCode===null&&value.process.signalCode===null)value.process.kill('SIGKILL');await value.exit;}await fs.rm(temporary,{recursive:true,force:true});});
    it('serializes three real writers without overlap and lets newcomers wait behind a current owner',async()=>{
        const holder=await start('hold');await holder.wait('entered');const contenders=await Promise.all(Array.from({length:3},()=>start('write')));
        await new Promise(resolve=>setTimeout(resolve,100));expect(contenders.every(value=>!value.events.some(event=>event.type==='entered'))).toBe(true);
        holder.process.send({type:'release'});expect(await holder.exit).toBe(0);
        for(const value of contenders)expect(await value.exit,value.stderr()).toBe(0);
        expect((await fs.readFile(path.join(directory,'entries.jsonl'),'utf8')).trim().split('\n')).toHaveLength(16);
        const stat=await fs.stat(path.join(directory,LEARNING_QUEUE_MUTEX));expect(stat.mode&0o077).toBe(0);
    },20000);
    it.each(['before-mutex','hold'])('recovers a killed process at %s without PID or stale-owner removal',async mode=>{
        const owner=await start(mode);await owner.wait(mode==='hold'?'entered':'before-mutex');expect(owner.process.kill('SIGKILL')).toBe(true);
        expect(await owner.exit,owner.stderr()).toBeNull();expect(owner.process.signalCode).toBe('SIGKILL');
        // Only the test's overlap sentinel is removed; the mutex database is never removed or replaced.
        await fs.rm(path.join(directory,'critical'),{force:true});const before=await fs.stat(path.join(directory,LEARNING_QUEUE_MUTEX));
        const contenders=await Promise.all(Array.from({length:3},()=>start('write')));
        for(const value of contenders)expect(await value.exit,value.stderr()).toBe(0);
        expect((await fs.stat(path.join(directory,LEARNING_QUEUE_MUTEX))).ino).toBe(before.ino);
    },20000);
    it('does not exceed capacity when three independent writers race for the last entry',async()=>{
        const first=observation();await enqueueLearningObservation(target,first,directory);const source=await fs.readFile(path.join(bucket(),first.requestKey+'.json'),'utf8');
        for(let index=1;index<LEARNING_QUEUE_LIMIT.entries-1;index++){const input=observation();await fs.writeFile(path.join(bucket(),input.requestKey+'.json'),source.replace(first.requestKey,input.requestKey),{mode:0o600});}
        const contenders=await Promise.all(Array.from({length:3},()=>start('enqueue'))),results=await Promise.all(contenders.map(value=>value.wait('result')));
        expect(results.filter(value=>value.ok)).toHaveLength(1);for(const value of contenders)expect(await value.exit,value.stderr()).toBe(0);
        expect(await records()).toHaveLength(LEARNING_QUEUE_LIMIT.entries);expect(await fs.readFile(path.join(bucket(),first.requestKey+'.json'),'utf8')).toBe(source);
    },20000);
    it.each(['queue-before-sync','queue-before','queue-after'])('recovers the original immutable payload after kill at %s publication',async mode=>{
        const owner=await start(mode),stage=await owner.wait(mode),input=stage.input as ReturnType<typeof observation>;expect(owner.process.kill('SIGKILL')).toBe(true);
        expect(await owner.exit,owner.stderr()).toBeNull();expect(owner.process.signalCode).toBe('SIGKILL');
        const orphan=(await fs.readdir(bucket())).find(name=>name.endsWith('.tmp'))!;let dataSynced=false;
        const open=fs.open.bind(fs),link=fs.link.bind(fs);
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0])===path.join(bucket(),orphan)){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();dataSynced=true;};}return handle;});
        vi.spyOn(fs,'link').mockImplementation(async(...args:Parameters<typeof fs.link>)=>{if(String(args[0])===path.join(bucket(),orphan))expect(dataSynced).toBe(true);return link(...args);});
        await enqueueLearningObservation(target,observation(),directory);expect(await records()).toHaveLength(2);
        expect(dataSynced).toBe(true);
        const recovered=JSON.parse(await fs.readFile(path.join(bucket(),input.requestKey+'.json'),'utf8'));expect(recovered.input).toEqual({...input,context:{}});
        expect((await fs.readdir(bucket())).filter(name=>name.endsWith('.tmp'))).toEqual([]);
    },15000);
    it('removes incomplete unpublished staging, preserves foreign complete staging, and retries directory durability',async()=>{
        const input=observation();await enqueueLearningObservation(target,input,directory);const incomplete=path.join(bucket(),'.'+randomUUID()+'.tmp');await fs.writeFile(incomplete,'{"schemaVersion":',{mode:0o600});
        const original=fs.open.bind(fs);let directorySyncs=0;
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await original(...args);if(String(args[0])===bucket())directorySyncs++;return handle;});
        await enqueueLearningObservation(target,input,directory);expect(directorySyncs).toBeGreaterThanOrEqual(2);await expect(fs.lstat(incomplete)).rejects.toMatchObject({code:'ENOENT'});
        const foreign=path.join(bucket(),'.'+randomUUID()+'.tmp'),body=JSON.parse(await fs.readFile(path.join(bucket(),input.requestKey+'.json'),'utf8'));body.target.projectId='prj-foreign';await fs.writeFile(foreign,JSON.stringify(body),{mode:0o600});
        await expect(enqueueLearningObservation(target,observation(),directory)).rejects.toThrow();expect(JSON.parse(await fs.readFile(foreign,'utf8')).target.projectId).toBe('prj-foreign');
        await syncDirectory(bucket());
    });
    it('rejects a symlink or replaced mutex database without opening the target',async()=>{
        const outside=path.join(temporary,'outside');await fs.writeFile(outside,'unchanged',{mode:0o600});await fs.symlink(outside,path.join(directory,LEARNING_QUEUE_MUTEX));
        await expect(withLearningQueueLock(directory,async()=>{})).rejects.toThrow();expect(await fs.readFile(outside,'utf8')).toBe('unchanged');
    });
    it('keeps the exact entry pending until a repeated directory-fsync succeeds',async()=>{
        const input=observation();await enqueueLearningObservation(target,input,directory);const file=path.join(bucket(),input.requestKey+'.json'),before=await fs.readFile(file);
        const original=fs.open.bind(fs);let attempts=0;
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
            const handle=await original(...args);if(String(args[0])===bucket()){const sync=handle.sync.bind(handle);handle.sync=async()=>{attempts++;if(attempts===1)throw Object.assign(Error('directory fsync unavailable'),{code:'EIO'});await sync();};}return handle;
        });
        await expect(enqueueLearningObservation(target,input,directory)).rejects.toMatchObject({code:'EIO'});expect(await fs.readFile(file)).toEqual(before);
        await expect(enqueueLearningObservation(target,input,directory)).resolves.toBeUndefined();expect(attempts).toBe(2);expect(await records()).toHaveLength(1);
    });
    it.runIf(!!process.env.OPENCODE_AGENT_TEST_ENGINE)('shares the mutex with native OpenCode/Bun and recovers its killed owner',async()=>{
        const node=await start('hold');await node.wait('entered');const native=await nativeQueueFixture(temporary,directory,'write');
        try{
            await native.wait(native.started);await new Promise(resolve=>setTimeout(resolve,100));await expect(fs.access(native.entered)).rejects.toMatchObject({code:'ENOENT'});
            node.process.send({type:'release'});expect(await node.exit,node.stderr()).toBe(0);expect(await native.exit,native.errors()).toBe(0);await fs.access(native.completed);
        }finally{await native.close();}
        const holder=await nativeQueueFixture(temporary,directory,'hold');
        try{
            await holder.wait(holder.entered);const contender=await start('write');await new Promise(resolve=>setTimeout(resolve,100));
            expect(contender.events.some(event=>event.type==='entered')).toBe(false);const before=await fs.stat(path.join(directory,LEARNING_QUEUE_MUTEX));
            expect(holder.child.kill('SIGKILL')).toBe(true);expect(await holder.exit,holder.errors()).toBeNull();expect(holder.child.signalCode).toBe('SIGKILL');
            expect(await contender.exit,contender.stderr()).toBe(0);expect((await fs.stat(path.join(directory,LEARNING_QUEUE_MUTEX))).ino).toBe(before.ino);
        }finally{await holder.close();}
    },60000);
});
