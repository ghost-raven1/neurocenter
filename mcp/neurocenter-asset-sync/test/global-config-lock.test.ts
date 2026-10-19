import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {globalConfigLockPath,withGlobalConfigLock} from '../src/lib/global-config-lock.js';

const require=createRequire(import.meta.url);
describe('Блокировка глобальной регистрации принадлежит конкретному процессу',()=>{
    let root:string,destination:string,lock:string;
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-global-lock-'));destination=path.join(root,'opencode.json');lock=globalConfigLockPath(destination);});
    afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
    const deadPid=123456789;
    async function owner(changes:Record<string,unknown>={}){
        const token=randomUUID(),name=`owner-${token}.json`;
        await fs.mkdir(lock);await fs.writeFile(path.join(lock,name),JSON.stringify({host:os.hostname(),pid:deadPid,token,...changes}));
        return name;
    }
    function markDead(){const kill=process.kill.bind(process);vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
        if(pid===deadPid)throw Object.assign(new Error('Процесс завершён'),{code:'ESRCH'});return kill(pid,signal);
    });}

    it('Две регистрации не пишут одновременно; отказавший процесс может повторить после освобождения',async()=>{
        let release!:()=>void,started!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
        const first=withGlobalConfigLock(destination,async()=>{started();await gate;});await ready;
        const second=vi.fn();await expect(withGlobalConfigLock(destination,second)).rejects.toThrow('Повторите');expect(second).not.toHaveBeenCalled();
        release();await first;await withGlobalConfigLock(destination,second);expect(second).toHaveBeenCalledOnce();
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('Подтверждённо умерший same-host процесс освобождает блокировку без второго guard',async()=>{
        await owner();markDead();const action=vi.fn();await withGlobalConfigLock(destination,action);
        expect(action).toHaveBeenCalledOnce();expect(await fs.readdir(root)).toEqual([]);
    });
    it.each([{host:'foreign-host'},{pid:0},{pid:process.pid}])('Чужой или неоднозначный владелец не удаляется: %j',async change=>{
        const name=await owner(change),before=await fs.readFile(path.join(lock,name),'utf8');
        await expect(withGlobalConfigLock(destination,vi.fn())).rejects.toThrow('блокировка');
        expect(await fs.readFile(path.join(lock,name),'utf8')).toBe(before);expect(await fs.readdir(root)).toEqual([path.basename(lock)]);
    });
    it('Пустая directory после остановки reclaim восстанавливается и при Windows EEXIST',async()=>{
        await fs.mkdir(lock);const rename=fs.rename.bind(fs);let injected=false;
        vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
            if(String(to)===lock&&!injected){injected=true;throw Object.assign(new Error('Windows rename'),{code:'EPERM'});}
            await rename(from,to);
        });
        await withGlobalConfigLock(destination,async()=>{});expect(injected).toBe(true);expect(await fs.readdir(root)).toEqual([]);
    });
    it('Конкурентный новый непустой lock не удаляется прежним reclaimer',async()=>{
        const old=await owner();markDead();const unlink=fs.unlink.bind(fs),next=randomUUID(),nextName=`owner-${next}.json`;
        let replaced=false;
        vi.spyOn(fs,'unlink').mockImplementation(async file=>{
            await unlink(file);
            if(String(file)===path.join(lock,old)&&!replaced){
                replaced=true;await fs.rmdir(lock);await fs.mkdir(lock);
                await fs.writeFile(path.join(lock,nextName),JSON.stringify({host:os.hostname(),pid:process.pid,token:next}));
            }
        });
        await expect(withGlobalConfigLock(destination,vi.fn())).rejects.toThrow('Повторите');
        expect(await fs.readdir(lock)).toEqual([nextName]);
    });
    it('Ошибка действия снимает только собственную блокировку и допускает повтор',async()=>{
        await expect(withGlobalConfigLock(destination,async()=>{throw new Error('disk unavailable');})).rejects.toThrow('disk unavailable');
        await withGlobalConfigLock(destination,async()=>{});expect(await fs.readdir(root)).toEqual([]);
    });
    it('После настоящего SIGKILL собственного subprocess следующая регистрация восстанавливается',async()=>{
        const source=`import {withGlobalConfigLock} from ${JSON.stringify(new URL('../src/lib/global-config-lock.ts',import.meta.url).href)};
            await withGlobalConfigLock(${JSON.stringify(destination)},async()=>{process.stdout.write('LOCKED\\n');await new Promise(()=>{setInterval(()=>{},1000);});});`;
        const child=spawn(process.execPath,['--import',require.resolve('tsx'),'--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
        let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
        const exited=new Promise<void>((resolve,reject)=>{child.once('exit',()=>resolve());child.once('error',reject);});
        try{
            await new Promise<void>((resolve,reject)=>{
                const timer=setTimeout(()=>reject(new Error('Lock subprocess timeout: '+stderr)),5000);
                child.stdout.on('data',chunk=>{if(String(chunk).includes('LOCKED')){clearTimeout(timer);resolve();}});
                child.once('exit',()=>{clearTimeout(timer);reject(new Error('Lock subprocess exited: '+stderr));});
            });
            child.kill('SIGKILL');await exited;
            await withGlobalConfigLock(destination,async()=>{});expect(await fs.readdir(root)).toEqual([]);
        }finally{child.kill('SIGKILL');await exited;}
    });
});
