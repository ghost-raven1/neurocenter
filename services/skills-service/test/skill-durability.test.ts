import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { SkillsService } from '../src/skills/skills.service';
import { AppController } from '../src/app.controller';
import { deliverSkillAudit, type TDeliverSkillAudit } from '../src/storage/skill-audit';
import { SKILL_JOURNAL_DIRECTORY, readSkillJournal } from '../src/storage/skill-journal';
import { versionRelative } from '../src/storage/skill-versions';
import { normalizeMeta } from '../src/storage/frontmatter';
import type { ISkillAuditEvent } from '../../shared/skill-audit.cjs';

const input={path:'common',slug:'helper',name:'Помощник',body:'Подтверждаемый текст',meta:{description:'Описание'}};
const actor='operator@example.test';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const eio=()=>Object.assign(new Error('Отказ fsync'),{code:'EIO'});
const execute=promisify(execFile);

describe('Подтверждение устойчивости файлового commit',()=>{
    let root:string;const opened:FsSkillsStorage[]=[];const servers:Server[]=[];
    const store=(deliver:TDeliverSkillAudit)=>{const item=new FsSkillsStorage(root,undefined,deliver);opened.push(item);return item;};
    const files=async()=>{try{return(await fs.readdir(path.join(root,SKILL_JOURNAL_DIRECTORY))).filter(name=>name.endsWith('.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){return [];}throw error;}};
    const fault=(fail:()=>Promise<boolean>)=>{
        const open=fs.open.bind(fs);const directory=path.join(root,SKILL_JOURNAL_DIRECTORY);
        return vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
            const handle=await open(...args);
            if(String(args[0])===directory){const sync=handle.sync.bind(handle);vi.spyOn(handle,'sync').mockImplementation(async()=>{if(await fail()){throw eio();}await sync();});}
            return handle;
        });
    };
    const committed=async()=>{for(const name of await files()){if((await readSkillJournal(path.join(root,SKILL_JOURNAL_DIRECTORY,name))).state==='committed'){return true;}}return false;};
    const expectUncertain=(work:Promise<unknown>)=>expect(work).rejects.toMatchObject({status:503,response:{code:'SKILL_DURABILITY_UNCERTAIN',durability:{state:'uncertain'}}});
    const network=async()=>{
        let requests=0;let loseAck=false;const accepted=new Map<string,ISkillAuditEvent>();
        const server=createServer(async(req,res)=>{
            if(req.url!=='/internal/skill-audit/events'||req.headers['x-neurocenter-internal']!=='d'.repeat(64)){res.writeHead(403).end();return;}
            let raw='';for await(const chunk of req){raw+=String(chunk);}
            const {events}=JSON.parse(raw) as {events:ISkillAuditEvent[]};requests++;
            for(const event of events){accepted.set(event.id,event);}
            if(loseAck){req.socket.destroy();return;}
            res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({accepted:events.length}));
        });servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        const port=(server.address() as {port:number}).port;
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','d'.repeat(64));vi.stubEnv('CATALOG_SERVICE_URL','http://127.0.0.1:'+port);
        return {accepted,requests:()=>requests,lose:()=>{loseAck=true;},restore:()=>{loseAck=false;}};
    };
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-durability-'));vi.stubEnv('NODE_ENV','production');vi.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);});
    afterEach(async()=>{for(const item of opened.splice(0)){await item.onModuleDestroy();}for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});});

    it('Видимый commit с EIO возвращает 503, не откатывается и закрывает новые записи, чтения и ready',async()=>{
        let failing=true;fault(async()=>failing&&await committed());const events:ISkillAuditEvent[]=[];
        const storage=store(async batch=>{events.push(...batch);});const service=new SkillsService(storage);
        await expectUncertain(service.createSkill(input,'user',actor));
        const before=await fs.readFile(path.join(root,'common/helper.md'),'utf8');expect(before).toContain(input.body);
        expect((await files())).toEqual([hash('common')+'.json']);expect(events).toEqual([]);
        await expectUncertain(service.getSkill('common/helper'));await expectUncertain(storage.existsSkill('common/helper'));
        await expectUncertain(service.createSkill({...input,path:'another',slug:'blocked'},'user',actor));
        await expectUncertain(service.createDirectory('another/blocked',actor));
        await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});
        await expectUncertain(storage.flushSkillAudit());expect(events).toEqual([]);
        await expect(fs.stat(path.join(root,'another'))).rejects.toMatchObject({code:'ENOENT'});
        failing=false;await storage.flushSkillAudit();expect(events).toHaveLength(1);
        expect(await fs.readFile(path.join(root,'common/helper.md'),'utf8')).toBe(before);
        expect((await service.getSkill('common/helper')).meta.version).toBe(1);
        await expect(new AppController(storage).ready()).resolves.toMatchObject({ok:true});
    });
    it('Два экземпляра делят отказ и после reinit доставляют один UUID без повторной записи',async()=>{
        let failing=true;fault(async()=>failing&&await committed());const events:ISkillAuditEvent[]=[];
        const deliver=async(batch:ISkillAuditEvent[])=>{events.push(...batch);};const first=store(deliver);
        await expectUncertain(new SkillsService(first).createSkill(input,'user',actor));
        const marker=await readSkillJournal(path.join(root,SKILL_JOURNAL_DIRECTORY,hash('common')+'.json'));
        const second=store(deliver);await second.init();
        await expectUncertain(new SkillsService(second).getSkill('common/helper'));expect(events).toEqual([]);
        await expect(new AppController(second).ready()).rejects.toMatchObject({status:503});
        failing=false;await Promise.all([first.flushSkillAudit(),second.flushSkillAudit()]);
        expect(events.map(event=>event.id)).toEqual(marker.events!.map(event=>event.id));expect(await files()).toEqual([]);
        await new SkillsService(second).createDirectory('another/allowed',actor);expect(events).toHaveLength(2);
    });
    it('Отказ committed A и rollback prepared B держит общий gate до проверки прежнего payload и полного отката',async()=>{
        const events:ISkillAuditEvent[]=[];const storage=store(async batch=>{events.push(...batch);});const service=new SkillsService(storage);
        const original=[{slug:'first',name:'Первый',body:'Первый до сбоя',version:1},{slug:'second',name:'Второй',body:'Второй до сбоя',version:1}];
        await service.syncSkills('rollback',original,actor);events.length=0;
        const paths=original.map(item=>path.join(root,'project-rollback',item.slug+'.md'));const before=await Promise.all(paths.map(file=>fs.readFile(file,'utf8')));
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
        const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);
        vi.spyOn(raw,'writeSkillChecked').mockImplementation(async(...args)=>{await write(...args);if(args[0]==='project-rollback/second'){entered();await hold;}});
        let failCommit=true;
        let failRollback=false;const open=fs.open.bind(fs);const headDirectory=await fs.realpath(path.join(root,'project-rollback'));
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
            const handle=await open(...args);
            if(String(args[0])===path.join(root,SKILL_JOURNAL_DIRECTORY)){const sync=handle.sync.bind(handle);vi.spyOn(handle,'sync').mockImplementation(async()=>{if(failCommit&&await committed()){throw eio();}await sync();});}
            if([headDirectory,path.join(root,'project-rollback')].includes(String(args[0]))){const sync=handle.sync.bind(handle);vi.spyOn(handle,'sync').mockImplementation(async()=>{if(failRollback){throw eio();}await sync();});}
            return handle;
        });
        const syncing=service.syncSkills('rollback',original.map(item=>({...item,version:2,body:'Незавершённая версия'})),actor);const rejected=expectUncertain(syncing);await started;
        await expectUncertain(service.createSkill(input,'user',actor));failCommit=false;failRollback=true;release();await rejected;
        const filename=path.join(root,SKILL_JOURNAL_DIRECTORY,hash('project-rollback')+'.json');const prepared=await fs.readFile(filename,'utf8');
        expect((await readSkillJournal(filename)).state).toBe('prepared');expect(await fs.readFile(paths[0],'utf8')).toContain('Незавершённая версия');
        await expectUncertain(storage.flushSkillAudit());expect(events).toEqual([]);
        await expectUncertain(service.getSkill('common/helper'));await expectUncertain(service.getSkill('project-rollback/first'));
        await expectUncertain(service.createDirectory('blocked/folder',actor));await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});
        failRollback=false;
        for(const field of ['actor','id']){
            const changed=JSON.parse(prepared);if(field==='actor'){changed.events[0].actor='forged@example.test';}else{changed.id='11111111-1111-4111-8111-111111111111';}
            await fs.writeFile(filename,JSON.stringify(changed));await expectUncertain(storage.flushSkillAudit());
            const reinitialized=store(async batch=>{events.push(...batch);});await reinitialized.init();
            await expect(new AppController(reinitialized).ready()).rejects.toMatchObject({status:503});
            expect(await fs.readFile(paths[0],'utf8')).toContain('Незавершённая версия');expect(events).toEqual([]);
        }
        await fs.writeFile(filename,prepared);const second=store(async batch=>{events.push(...batch);});
        await Promise.all([storage.flushSkillAudit(),second.flushSkillAudit()]);
        expect(await Promise.all(paths.map(file=>fs.readFile(file,'utf8')))).toEqual(before);
        expect(events).toHaveLength(1);expect(events[0]).toMatchObject({action:'skill.create',resourceId:'common/helper'});expect(await files()).toEqual([]);
        await expect(new AppController(second).ready()).resolves.toMatchObject({ok:true});
    });
    it('Prepared gate переживает отказ резервов и не допускает чужого живого владельца при явном retry',async()=>{
        const meta=normalizeMeta({name:'Помощник',dependencies:[{id:'ai-plug-dependency',kind:'mcp',version:1,manifest:'a'.repeat(64)}]},'helper');
        const storage=store(async()=>undefined);await storage.writeSkill('common/helper',meta,'Прежний текст');
        const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);let rollback=false;
        vi.spyOn(raw,'writeSkillChecked').mockImplementationOnce(async(...args)=>{await write(...args);rollback=true;throw new Error('Остановить до commit');});
        const open=fs.open.bind(fs);const headDirectory=await fs.realpath(path.join(root,'common'));
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if([headDirectory,path.join(root,'common')].includes(String(args[0]))){const sync=handle.sync.bind(handle);vi.spyOn(handle,'sync').mockImplementation(async()=>{if(rollback){throw eio();}await sync();});}return handle;});
        await expectUncertain(storage.writeSkill('common/helper',{...meta,version:2},'Новый текст'));
        rollback=false;const reserve=vi.fn(async()=>{throw new Error('Каталог резервов недоступен');});const recovering=new FsSkillsStorage(root,reserve,async()=>undefined);opened.push(recovering);
        await expect(recovering.init()).rejects.toThrow('Каталог резервов недоступен');expect(reserve).toHaveBeenCalledOnce();
        await expectUncertain(storage.readSkill('common/helper'));await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});
        const filename=path.join(root,SKILL_JOURNAL_DIRECTORY,hash('common')+'.json');const original=await fs.readFile(filename,'utf8');const journal=JSON.parse(original);journal.host='another-live-host';await fs.writeFile(filename,JSON.stringify(journal));
        await expect(storage.flushSkillAudit()).rejects.toThrow('занят другим процессом');await expectUncertain(storage.readSkill('common/helper'));
        await fs.writeFile(filename,original);await storage.flushSkillAudit();expect((await storage.readSkill('common/helper')).body).toBe('Прежний текст');expect(await files()).toEqual([]);
    });
    it.each(['head','marker'] as const)('Prepared rollback с EIO %s не готов до повторного fsync уже удалённых данных',async failure=>{
        const events:ISkillAuditEvent[]=[];const storage=store(async batch=>{events.push(...batch);});const service=new SkillsService(storage);
        let rollback=false;let failing=true;const physical=await fs.realpath(root);const mkdir=fs.mkdir.bind(fs);vi.spyOn(fs,'mkdir').mockImplementation(async(...args:Parameters<typeof fs.mkdir>)=>{const result=await mkdir(...args);if([path.join(root,'common/folder'),path.join(physical,'common/folder')].includes(String(args[0]))){rollback=true;throw new Error('Остановить до commit');}return result;});
        const open=fs.open.bind(fs);
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if([root,path.join(root,'common'),path.join(root,SKILL_JOURNAL_DIRECTORY)].includes(String(args[0]))){const sync=handle.sync.bind(handle);vi.spyOn(handle,'sync').mockImplementation(async()=>{const matches=failure==='head'?[root,path.join(root,'common')].includes(String(args[0])):String(args[0])===path.join(root,SKILL_JOURNAL_DIRECTORY);if(rollback&&failing&&matches&&(failure==='head'||(await files()).length===0)){throw eio();}await sync();});}return handle;});
        await expectUncertain(service.createDirectory('common/folder',actor));expect(events).toEqual([]);
        await expect(fs.stat(path.join(root,'common/folder'))).rejects.toMatchObject({code:'ENOENT'});
        await expectUncertain(storage.flushSkillAudit());await expectUncertain(service.getTree());await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});
        failing=false;await storage.flushSkillAudit();expect(events).toEqual([]);expect(await files()).toEqual([]);
        await expect(new AppController(storage).ready()).resolves.toMatchObject({ok:true});
    });
    it.each(['update','delete','sync'] as const)('EIO после %s сохраняет видимый результат и историю до безопасного audit retry',async operation=>{
        const events:ISkillAuditEvent[]=[];const storage=store(async batch=>{events.push(...batch);});const service=new SkillsService(storage);
        const created=await service.createSkill({...input,path:'project-durable'},'user',actor);
        const original=[{slug:'one',name:'Первый',body:'Первый',version:1},{slug:'old',name:'Старый',body:'Старый',version:1}];
        if(operation==='sync'){await service.syncSkills('qa',original,actor);}
        const count=events.length;let failing=true;fault(async()=>failing&&await committed());
        const next=[{...original[0],body:'Изменён'},{slug:'new',name:'Новый',body:'Новый',version:1}];
        const work=operation==='update'?service.updateSkill(created.path,{expectedVersion:1,body:'Обновлено'},'user',actor)
            :operation==='delete'?service.deleteSkill(created.path,actor):service.syncSkills('qa',next,actor);
        await expectUncertain(work);expect(events).toHaveLength(count);
        const targets=operation==='sync'?['project-qa/one','project-qa/new']:operation==='update'?[created.path]:[];
        const before=await Promise.all(targets.map(relative=>fs.readFile(path.join(root,relative+'.md'),'utf8')));
        if(operation==='delete'){await expect(fs.stat(path.join(root,created.path+'.md'))).rejects.toMatchObject({code:'ENOENT'});}
        if(operation!=='sync'){expect(await fs.readFile(path.join(root,versionRelative(created.path,created.meta,1)),'utf8')).toContain(input.body);}
        failing=false;await storage.flushSkillAudit();
        expect(events.slice(count).map(event=>event.action)).toEqual(operation==='sync'?['skill.update','skill.create','skill.delete']:['skill.'+operation]);
        expect(await Promise.all(targets.map(relative=>fs.readFile(path.join(root,relative+'.md'),'utf8')))).toEqual(before);
        if(operation==='delete'){await expect(service.getSkill(created.path)).rejects.toMatchObject({status:404});}
        if(operation==='update'){await service.updateSkill(created.path,{expectedVersion:2,body:'Обновлено'},'user',actor);expect(events).toHaveLength(count+1);}
    });
    it('Visible commit папки не откатывается и не аудируется при EIO до подтверждения commit',async()=>{
        let failing=true;fault(async()=>failing&&await committed());const events:ISkillAuditEvent[]=[];
        const storage=store(async batch=>{events.push(...batch);});const service=new SkillsService(storage);
        await expectUncertain(service.createDirectory('common/folder',actor));
        expect((await fs.stat(path.join(root,'common/folder'))).isDirectory()).toBe(true);expect(events).toEqual([]);
        await expectUncertain(service.getTree());failing=false;await storage.flushSkillAudit();
        expect(events).toHaveLength(1);expect(events[0].action).toBe('skill.directory.create');
    });
    it('Отказ fsync после архивного rename не позволяет подтвердить событие',async()=>{
        let failing=true;fault(async()=>failing&&(await files()).some(name=>name.startsWith('audit-')));
        const events:ISkillAuditEvent[]=[];const storage=store(async batch=>{events.push(...batch);});
        await expectUncertain(new SkillsService(storage).createDirectory('common/folder',actor));
        expect((await files())[0]).toMatch(/^audit-/);expect(events).toEqual([]);
        expect((await fs.stat(path.join(root,'common/folder'))).isDirectory()).toBe(true);
        failing=false;await storage.flushSkillAudit();expect(events).toHaveLength(1);expect(events[0].action).toBe('skill.directory.create');
    });
    it('Выполненный archive rename с ответом EIO восстанавливается healthy flush без reinit и отправляет один HTTP UUID',async()=>{
        const endpoint=await network();const rename=fs.rename.bind(fs);let failed=false;
        vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{await rename(from,to);if(!failed&&path.basename(String(to)).startsWith('audit-')){failed=true;throw eio();}});
        const storage=store(deliverSkillAudit);await expectUncertain(new SkillsService(storage).createSkill(input,'user',actor));
        const before=await fs.readFile(path.join(root,'common/helper.md'),'utf8');expect(await files()).toHaveLength(1);expect((await files())[0]).toMatch(/^audit-/);expect(endpoint.requests()).toBe(0);
        await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});await storage.flushSkillAudit();
        expect(endpoint.requests()).toBe(1);expect(endpoint.accepted.size).toBe(1);expect(await files()).toEqual([]);expect(await fs.readFile(path.join(root,'common/helper.md'),'utf8')).toBe(before);
        await expect(new AppController(storage).ready()).resolves.toMatchObject({ok:true});
    });
    it.each(['actor','uuid','foreign-pid','both-differ','both-forged','both-equal'] as const)('Archive reconcile %s проверяет оба payload и владельца до снятия gate',async scenario=>{
        const events:ISkillAuditEvent[]=[];const storage=store(async batch=>{events.push(...batch);});const rename=fs.rename.bind(fs);let failed=false;
        vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{await rename(from,to);if(!failed&&path.basename(String(to)).startsWith('audit-')){failed=true;throw eio();}});
        await expectUncertain(new SkillsService(storage).createSkill(input,'user',actor));
        const original=path.join(root,SKILL_JOURNAL_DIRECTORY,hash('common')+'.json');const destination=path.join(root,SKILL_JOURNAL_DIRECTORY,(await files())[0]);const raw=await fs.readFile(destination,'utf8');const journal=JSON.parse(raw);
        if(scenario==='foreign-pid'){const failing=fault(async()=>true);await expectUncertain(storage.flushSkillAudit());failing.mockRestore();await fs.writeFile(original,JSON.stringify({...journal,pid:process.ppid}));}
        else if(scenario==='both-equal'){await fs.writeFile(original,raw);}
        else {if(scenario==='both-differ'){await fs.writeFile(original,raw);}if(scenario==='uuid'){journal.id='11111111-1111-4111-8111-111111111111';}else{journal.events[0].actor='forged@example.test';}await fs.writeFile(destination,JSON.stringify(journal));if(scenario==='both-forged'){await fs.writeFile(original,JSON.stringify(journal));}}
        if(scenario==='both-equal'){await storage.flushSkillAudit();}
        else {
            if(scenario==='foreign-pid'){await expect(storage.flushSkillAudit()).rejects.toThrow('занят другим процессом');}else{await expectUncertain(storage.flushSkillAudit());}
            expect(events).toEqual([]);await expectUncertain(storage.readSkill('common/helper'));await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});
            await fs.rm(original,{force:true});await fs.writeFile(destination,raw);await storage.flushSkillAudit();
        }
        expect(events).toHaveLength(1);expect(events[0].id).toBe(JSON.parse(raw).events[0].id);expect(await files()).toEqual([]);
        await expect(new AppController(storage).ready()).resolves.toMatchObject({ok:true});
    });
    it('Отказ fsync после ACK и unlink оставляет gate до подтверждения каталога без нового события',async()=>{
        let failing=true;let ack=false;fault(async()=>failing&&ack&&(await files()).length===0);
        const events:ISkillAuditEvent[]=[];const storage=store(async batch=>{events.push(...batch);ack=true;});
        await expectUncertain(new SkillsService(storage).createSkill(input,'user',actor));
        expect(await files()).toEqual([]);expect(events).toHaveLength(1);
        await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});
        const second=store(async batch=>{events.push(...batch);});await second.init();
        await expectUncertain(second.flushSkillAudit());failing=false;
        await Promise.all([storage.flushSkillAudit(),second.flushSkillAudit()]);
        expect(events).toHaveLength(1);await expect(new AppController(storage).ready()).resolves.toMatchObject({ok:true});
    });
    it('Подменённый после EIO payload не принимается за прежний commit',async()=>{
        let failing=true;fault(async()=>failing&&await committed());const events:ISkillAuditEvent[]=[];
        const storage=store(async batch=>{events.push(...batch);});await expectUncertain(new SkillsService(storage).createSkill(input,'user',actor));
        const filename=path.join(root,SKILL_JOURNAL_DIRECTORY,hash('common')+'.json');const journal=await readSkillJournal(filename);
        journal.events![0].actor='forged@example.test';await fs.writeFile(filename,JSON.stringify(journal));failing=false;
        await expectUncertain(storage.flushSkillAudit());expect(events).toEqual([]);
        await expect(new AppController(storage).ready()).rejects.toMatchObject({status:503});
    });
    it('Explicit flush не архивирует committed журнал другого живого владельца',async()=>{
        const storage=store(async()=>{throw new Error('Не должен вызываться');});
        const open=fault(async()=>await committed());await expectUncertain(new SkillsService(storage).createSkill(input,'user',actor));open.mockRestore();
        const filename=path.join(root,SKILL_JOURNAL_DIRECTORY,hash('common')+'.json');const journal=await readSkillJournal(filename);
        journal.host='another-live-host';await fs.writeFile(filename,JSON.stringify(journal));
        await expect(storage.flushSkillAudit()).rejects.toThrow('занят другим процессом');
        expect(await fs.readFile(filename,'utf8')).toContain('another-live-host');
    });
    it('Реальный HTTP не получает событие до fsync proof; потеря ACK затем оставляет только audit pending',async()=>{
        const endpoint=await network();let failing=true;fault(async()=>failing&&await committed());const storage=store(deliverSkillAudit);const service=new SkillsService(storage);
        await expectUncertain(service.createSkill(input,'user',actor));expect(endpoint.requests()).toBe(0);
        failing=false;endpoint.lose();await expect(storage.flushSkillAudit()).rejects.toMatchObject({status:503});
        expect(endpoint.requests()).toBe(1);expect(endpoint.accepted.size).toBe(1);
        expect((await service.getSkill('common/helper')).meta.version).toBe(1);
        expect(await storage.pendingAudit()).toBe(true);endpoint.restore();await storage.flushSkillAudit();
        expect(endpoint.requests()).toBe(2);expect(endpoint.accepted.size).toBe(1);
        await expect(new AppController(storage).ready()).resolves.toMatchObject({ok:true});
    });
    it('Остановка во время повторного fsync не начинает HTTP после завершения proof',async()=>{
        let mode:'fail'|'pause'|'healthy'='fail';let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
        fault(async()=>{if(!await committed()){return false;}if(mode==='pause'){entered();await hold;}return mode==='fail';});
        const deliver=vi.fn(async()=>undefined);const storage=store(deliver);
        await expectUncertain(new SkillsService(storage).createSkill(input,'user',actor));mode='pause';
        const flush=storage.flushSkillAudit();await started;const stop=storage.onModuleDestroy();mode='healthy';release();await flush;await stop;
        expect(deliver).not.toHaveBeenCalled();expect(await files()).toEqual([hash('common')+'.json']);
        const next=store(deliver);await next.init();expect(deliver).toHaveBeenCalledOnce();
    });
    it('Новые процессы повторяют proof после restart и не объявляют persistent EIO готовым',async()=>{
        const endpoint=await network();const serviceRoot=fileURLToPath(new URL('..',import.meta.url));
        const script=path.join(root,'restart.cjs');const source=path.join(serviceRoot,'src');
        await fs.writeFile(script,`
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
require(${JSON.stringify(path.join(serviceRoot,'node_modules/reflect-metadata'))});
const {FsSkillsStorage}=require(${JSON.stringify(path.join(source,'storage/fs-skills-storage.ts'))});
const {SkillsService}=require(${JSON.stringify(path.join(source,'skills/skills.service.ts'))});
const {AppController}=require(${JSON.stringify(path.join(source,'app.controller.ts'))});
const {deliverSkillAudit}=require(${JSON.stringify(path.join(source,'storage/skill-audit.ts'))});
const root=process.argv[2],mode=process.argv[3],directory=path.join(root,'.neurocenter-sync-journal');
const original=fs.open.bind(fs);
if(mode!=='healthy'){fs.open=async(...args)=>{const handle=await original(...args);if(String(args[0])===directory){const sync=handle.sync.bind(handle);handle.sync=async()=>{let names=[];try{names=(await fs.readdir(directory)).filter(n=>n.endsWith('.json'));}catch{}for(const name of names){const journal=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));if(journal.state==='committed'){throw Object.assign(new Error('EIO'),{code:'EIO'});}}await sync();};}return handle;};}
(async()=>{const storage=new FsSkillsStorage(root,undefined,deliverSkillAudit);let response;try{if(mode==='create'){try{await new SkillsService(storage).createSkill(${JSON.stringify(input)},'user',${JSON.stringify(actor)});}catch(error){response=error.getResponse();}}else{await storage.init();}let ready;try{await new AppController(storage).ready();ready=200;}catch(error){ready=error.status;}const bytes=await fs.readFile(path.join(root,'common/helper.md'));process.stdout.write(JSON.stringify({mode,response,ready,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),journals:(await fs.readdir(directory)).filter(n=>n.endsWith('.json'))})+'\\n');}finally{await storage.onModuleDestroy();}})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
`);
        const run=async(mode:string)=>{
            const result=await execute(process.execPath,['-r',path.join(serviceRoot,'node_modules/ts-node/register/transpile-only'),script,root,mode],
                {env:{...process.env,TS_NODE_PROJECT:path.join(serviceRoot,'tsconfig.json'),NODE_ENV:'production'},timeout:15000});
            return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {ready:number;sha256:string;journals:string[];response?:{code:string}};
        };
        const first=await run('create');expect(first.response?.code).toBe('SKILL_DURABILITY_UNCERTAIN');expect(first.ready).toBe(503);expect(endpoint.requests()).toBe(0);
        const retry=await run('persistent-eio');expect(retry.ready).toBe(503);expect(retry.sha256).toBe(first.sha256);expect(endpoint.requests()).toBe(0);
        const healthy=await run('healthy');expect(healthy.ready).toBe(200);expect(healthy.sha256).toBe(first.sha256);expect(healthy.journals).toEqual([]);
        expect(endpoint.requests()).toBe(1);expect(endpoint.accepted.size).toBe(1);
        if(process.env.SKILLS_DURABILITY_REPORT){await fs.writeFile(process.env.SKILLS_DURABILITY_REPORT,JSON.stringify({first,persistentEio:retry,healthy,httpRequests:endpoint.requests(),eventIds:[...endpoint.accepted.keys()]},null,2)+'\n');}
    },20000);
    it('Новые процессы держат prepared rollback закрытым при EIO и завершают его без аудита незавершённого пакета',async()=>{
        const endpoint=await network();const serviceRoot=fileURLToPath(new URL('..',import.meta.url));const source=path.join(serviceRoot,'src');const script=path.join(root,'prepared-restart.cjs');
        await fs.writeFile(script,`
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
require(${JSON.stringify(path.join(serviceRoot,'node_modules/reflect-metadata'))});
const {FsSkillsStorage}=require(${JSON.stringify(path.join(source,'storage/fs-skills-storage.ts'))});
const {AppController}=require(${JSON.stringify(path.join(source,'app.controller.ts'))});
const {normalizeMeta}=require(${JSON.stringify(path.join(source,'storage/frontmatter.ts'))});
const {deliverSkillAudit}=require(${JSON.stringify(path.join(source,'storage/skill-audit.ts'))});
const root=process.argv[2],mode=process.argv[3],directory=path.join(root,'.neurocenter-sync-journal');let rollback=mode==='persistent-eio';
(async()=>{if(mode==='create'){const initial=new FsSkillsStorage(root);for(const slug of ['first','second']){await initial.writeSkill('common/'+slug,normalizeMeta({name:slug},slug),'Прежний '+slug);}await fs.writeFile(path.join(root,'expected-sha'),crypto.createHash('sha256').update(await fs.readFile(path.join(root,'common/first.md'))).digest('hex'));}
const physical=await fs.realpath(root),open=fs.open.bind(fs);if(mode!=='healthy'){fs.open=async(...args)=>{const handle=await open(...args);if([path.join(root,'common'),path.join(physical,'common')].includes(String(args[0]))){const sync=handle.sync.bind(handle);handle.sync=async()=>{if(rollback){throw Object.assign(new Error('EIO'),{code:'EIO'});}await sync();};}return handle;};}
const storage=new FsSkillsStorage(root,undefined,deliverSkillAudit);let response;try{if(mode==='create'){const original=storage.writeSkillChecked.bind(storage);storage.writeSkillChecked=async(...args)=>{await original(...args);if(args[0]==='common/second'){rollback=true;throw new Error('Остановить до commit');}};const changes=[];for(const slug of ['first','second']){const current=await storage.readSkill('common/'+slug);changes.push({path:current.path,next:{...current,meta:{...current.meta,version:2},body:'Незавершённый '+slug}});}try{await storage.applySkillChanges(changes,{actor:${JSON.stringify(actor)},source:'sync'});}catch(error){response=error.getResponse();}}else{await storage.init();}let ready;try{await new AppController(storage).ready();ready=200;}catch(error){ready=error.status;}process.stdout.write(JSON.stringify({mode,response,ready,sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(root,'common/first.md'))).digest('hex'),expectedSha256:await fs.readFile(path.join(root,'expected-sha'),'utf8'),journals:(await fs.readdir(directory)).filter(n=>n.endsWith('.json'))})+'\\n');}finally{await storage.onModuleDestroy();}})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
`);
        const run=async(mode:string)=>{
            const result=await execute(process.execPath,['-r',path.join(serviceRoot,'node_modules/ts-node/register/transpile-only'),script,root,mode],
                {env:{...process.env,TS_NODE_PROJECT:path.join(serviceRoot,'tsconfig.json'),NODE_ENV:'production'},timeout:15000});
            return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {ready:number;sha256:string;expectedSha256:string;journals:string[];response?:{code:string}};
        };
        const first=await run('create');expect(first.response?.code).toBe('SKILL_DURABILITY_UNCERTAIN');expect(first.ready).toBe(503);expect(first.sha256).not.toBe(first.expectedSha256);
        const retry=await run('persistent-eio');expect(retry.ready).toBe(503);expect(retry.sha256).toBe(first.sha256);expect(retry.journals).toEqual(first.journals);
        const healthy=await run('healthy');expect(healthy.ready).toBe(200);expect(healthy.sha256).toBe(first.expectedSha256);expect(healthy.journals).toEqual([]);expect(endpoint.requests()).toBe(0);
        if(process.env.SKILLS_DURABILITY_REPORT){await fs.writeFile(path.join(path.dirname(process.env.SKILLS_DURABILITY_REPORT),'prepared-restart-evidence.json'),JSON.stringify({first,persistentEio:retry,healthy,httpRequests:endpoint.requests()},null,2)+'\n');}
    },20000);
});
