import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {workspaceBindingReport} from '../src/bridge/workspace-instance.js';
import {createProjectDataSizeReporter,measureProjectDataSize} from '../src/bridge/project-data-size.js';
import {workspaceFixture} from './bridge-fixture.js';

describe('Размер .opencode проверенной локальной привязки',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>|undefined;
    const temporary:string[]=[];
    const root=async()=>{const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-project-size-')));temporary.push(directory);return directory;};
    const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
    afterEach(async()=>{
        vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();
        if(fixture){await fs.rm(fixture.temporary,{recursive:true,force:true});fixture=undefined;}
        await Promise.all(temporary.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));
    });

    it('Отдаёт полный локальный размер без файла конфигурации плагина и без исходников проекта',async()=>{
        const current=fixture=await workspaceFixture();
        await fs.writeFile(path.join(current.root,'source.txt'),'Этот файл не входит в .opencode');
        await fs.writeFile(path.join(current.root,'.opencode','knowledge.bin'),'local index');
        const expected=(await fs.stat(path.join(current.root,'.opencode','neurocenter.json'))).size+Buffer.byteLength('local index');
        await vi.waitFor(async()=>{
            const report=await workspaceBindingReport('test-project',current.root);
            expect(report).toMatchObject({valid:true,dataSize:{scope:'opencode',bytes:expected,measuredAt:expect.any(String)}});
        },{timeout:500});
        await expect(fs.stat(path.join(current.root,'opencode-rag.json'))).rejects.toMatchObject({code:'ENOENT'});
        const measured=(await workspaceBindingReport('test-project',current.root)).dataSize;
        expect(measured?.error).toBeUndefined();
        expect(new Date(measured!.measuredAt).toISOString()).toBe(measured!.measuredAt);
        await fs.rename(current.root,current.root+'-old');temporary.push(current.root+'-old');
        await fs.mkdir(current.root,{recursive:true});
        await fs.cp(path.join(current.root+'-old','.opencode'),path.join(current.root,'.opencode'),{recursive:true});
        const changed=await workspaceBindingReport('test-project',current.root);
        expect(changed).toMatchObject({valid:false,identityStatus:'changed'});
        expect(changed).not.toHaveProperty('dataSize');
    });

    it('Настоящие пустые каталоги дают 0, отсутствие корня не выдаётся за пустой проект',async()=>{
        const directory=await root();
        expect(await measureProjectDataSize(directory)).toEqual({bytes:0});
        await fs.mkdir(path.join(directory,'.opencode'));
        expect(await measureProjectDataSize(directory)).toEqual({bytes:0});
        expect(await measureProjectDataSize(path.join(directory,'missing'))).toEqual({bytes:null,error:'unavailable'});
    });

    it('Считает все обычные файлы .opencode, не следует по ссылкам и отвергает ссылку вместо корня данных',async()=>{
        const directory=await root(),outside=await root();
        await fs.mkdir(path.join(directory,'.opencode','nested'),{recursive:true});
        await fs.writeFile(path.join(directory,'.opencode','first'),'12345');
        await fs.writeFile(path.join(directory,'.opencode','nested','second'),'678');
        await fs.writeFile(path.join(outside,'secret'),'not project bytes');
        await fs.symlink(outside,path.join(directory,'.opencode','outside'));
        await fs.symlink(path.join(outside,'secret'),path.join(directory,'.opencode','link'));
        expect(await measureProjectDataSize(directory)).toEqual({bytes:8});
        await fs.rename(path.join(directory,'.opencode'),path.join(directory,'old'));
        await fs.symlink(outside,path.join(directory,'.opencode'));
        expect(await measureProjectDataSize(directory)).toEqual({bytes:null,error:'unavailable'});
    });

    it('Ошибка после прочитанного файла не публикует частичную сумму и локальный путь',async()=>{
        const directory=await root(),denied=path.join(directory,'.opencode','denied');
        await fs.mkdir(path.dirname(denied));await fs.writeFile(path.join(path.dirname(denied),'ready'),'12345');await fs.writeFile(denied,'secret');
        const lstat=fs.lstat;
        vi.spyOn(fs,'lstat').mockImplementation(async(...args:Parameters<typeof fs.lstat>)=>{
            if(args[0]===denied)throw Object.assign(new Error(denied),{code:'EACCES'});
            return lstat(...args);
        });
        expect(await measureProjectDataSize(directory)).toEqual({bytes:null,error:'unavailable'});
    });

    it('Глубокий каталог возвращает ограничение вместо частичных байтов',async()=>{
        const directory=await root();let nested=path.join(directory,'.opencode');
        for(let depth=0;depth<34;depth++)nested=path.join(nested,'child');
        await fs.mkdir(nested,{recursive:true});await fs.writeFile(path.join(nested,'bytes'),'123');
        expect(await measureProjectDataSize(directory)).toEqual({bytes:null,error:'limit-exceeded'});
    });

    it('Зависшее чтение ограничено дедлайном; после возврата I/O обход не продолжается',async()=>{
        const directory=await root(),blocked=path.join(directory,'.opencode','blocked'),gate=deferred(),entered=deferred();
        await fs.mkdir(path.dirname(blocked));await fs.writeFile(blocked,'123');
        const lstat=fs.lstat;
        vi.spyOn(fs,'lstat').mockImplementation(async(...args:Parameters<typeof fs.lstat>)=>{
            if(args[0]===blocked){entered.resolve();await gate.promise;}
            return lstat(...args);
        });
        const running=measureProjectDataSize(directory);await entered.promise;
        expect(await running).toEqual({bytes:null,error:'limit-exceeded'});
        gate.resolve();await new Promise(resolve=>setImmediate(resolve));
    });

    it('Фоновая очередь не удерживает отчёт, объединяет повтор и не запускает два обхода одновременно',async()=>{
        const first=await root(),second=await root(),gate=deferred();let active=0,maxActive=0;
        const measure=vi.fn(async(directory:string)=>{
            active++;maxActive=Math.max(maxActive,active);if(directory===first)await gate.promise;
            const value=await measureProjectDataSize(directory);active--;return value;
        });
        const report=createProjectDataSizeReporter(measure),current=async()=>true;
        const one={key:'first',root:first,isCurrent:current},two={key:'second',root:second,isCurrent:current};
        expect(report(one)).toBeUndefined();expect(report(one)).toBeUndefined();expect(report(two)).toBeUndefined();
        await vi.waitFor(()=>expect(measure).toHaveBeenCalledTimes(1));
        gate.resolve();await vi.waitFor(()=>expect(report(two)).toMatchObject({scope:'opencode',bytes:0}));
        expect(report(one)).toMatchObject({scope:'opencode',bytes:0});expect(measure).toHaveBeenCalledTimes(2);expect(maxActive).toBe(1);
    });

    it('После дедлайна зависший native I/O удерживает единственный слот даже при следующих heartbeat и других проектах',async()=>{
        const first=await root(),second=await root(),third=await root(),gate=deferred(),entered=deferred(),starts:string[]=[];
        const lstat=fs.lstat;
        vi.spyOn(fs,'lstat').mockImplementation(async(...args:Parameters<typeof fs.lstat>)=>{
            if([first,second,third].includes(String(args[0])))starts.push(String(args[0]));
            if(args[0]===first){entered.resolve();await gate.promise;}
            return lstat(...args);
        });
        const report=createProjectDataSizeReporter(),request=(directory:string)=>({key:directory,root:directory,isCurrent:async()=>true});
        expect(report(request(first))).toBeUndefined();await entered.promise;
        expect(report(request(second))).toBeUndefined();
        await vi.waitFor(()=>expect(report(request(first))).toMatchObject({bytes:null,error:'limit-exceeded'}),{timeout:1500});
        const measured=report(request(first))!;
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(measured.measuredAt)+35000);
        expect(report(request(first))).toEqual(measured);expect(report(request(third))).toBeUndefined();
        vi.setSystemTime(Date.parse(measured.measuredAt)+65000);
        for(let index=0;index<5;index++){expect(report(request(first))).toBeUndefined();expect(report(request(second))).toBeUndefined();}
        expect(starts).toEqual([first]);
        gate.resolve();await vi.waitFor(()=>expect(report(request(second))).toMatchObject({bytes:0}));
        expect(starts.filter(directory=>directory===first)).toHaveLength(1);
    });

    it('Результат прежней привязки, изменившейся во время обхода, не попадает в кеш',async()=>{
        const directory=await root(),gate=deferred(),entered=deferred();let current=true;
        const measure=vi.fn(async()=>{entered.resolve();await gate.promise;return measureProjectDataSize(directory);});
        const report=createProjectDataSizeReporter(measure),request={key:'old-binding',root:directory,isCurrent:async()=>current};
        report(request);await entered.promise;current=false;gate.resolve();
        await vi.waitFor(()=>expect(measure).toHaveResolved());
        await new Promise(resolve=>setImmediate(resolve));
        expect(report(request)).toBeUndefined();
    });

    it('Повторный heartbeat не освежает measuredAt; старые данные скрываются при незавершённом обновлении',async()=>{
        const directory=await root(),gate=deferred();let count=0;
        const report=createProjectDataSizeReporter(async()=>{if(++count===2)await gate.promise;return measureProjectDataSize(directory);});
        const request={key:'stable-binding',root:directory,isCurrent:async()=>true};
        report(request);await vi.waitFor(()=>expect(report(request)?.bytes).toBe(0));
        const first=report(request)!;
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(first.measuredAt)+35000);
        expect(report(request)).toEqual(first);await new Promise(resolve=>setImmediate(resolve));
        vi.setSystemTime(Date.parse(first.measuredAt)+65000);expect(report(request)).toBeUndefined();
        gate.resolve();await vi.waitFor(()=>{
            const refreshed=report(request);expect(refreshed).toMatchObject({scope:'opencode',bytes:0});
            expect(Date.parse(refreshed!.measuredAt)).toBeGreaterThanOrEqual(Date.parse(first.measuredAt)+65000);
        });
    });
});
