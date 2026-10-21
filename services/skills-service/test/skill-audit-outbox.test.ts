import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { SkillsService } from '../src/skills/skills.service';
import { SkillsController } from '../src/skills/skills.controller';
import { AppController } from '../src/app.controller';
import { normalizeMeta, serializeSkillFile } from '../src/storage/frontmatter';
import { skillAuditEvents, type TDeliverSkillAudit } from '../src/storage/skill-audit';
import { SKILL_JOURNAL_DIRECTORY, parseSkillJournal, withSkillScope, type ISkillJournal } from '../src/storage/skill-journal';
import { scanSkillDependencyUsage } from '../src/storage/skill-dependency-usage';
import type { ISkillAuditEvent } from '../../shared/skill-audit.cjs';
import type { Request } from 'express';

const actor = 'operator@example.test';
const input = { path:'project-audit',slug:'helper',name:'Помощник',body:'Приватная инструкция',meta:{description:'Описание тестового скилла'} };
const context = {actor,source:'editor' as const};
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const raw = (version=1,body='До сбоя') => serializeSkillFile(normalizeMeta({generation:'generation-test',name:'Помощник',version},'helper'),body);

describe('Устойчивый аудит файловых скиллов', () => {
    let root:string; const opened:FsSkillsStorage[]=[];
    const storage = (deliver:TDeliverSkillAudit) => { const item=new FsSkillsStorage(root,undefined,deliver); opened.push(item); return item; };
    const files = () => fs.readdir(path.join(root,SKILL_JOURNAL_DIRECTORY));
    const fixture = async (state:'prepared'|'committed',before=raw(),after:string|null=raw(2,'После сбоя')) => {
        const changes=[{relative:'project-audit/helper.md',before,after}];
        const journal:ISkillJournal={version:1,id:randomUUID(),host:os.hostname(),pid:process.pid,state,changes,events:skillAuditEvents(changes,context)};
        await fs.mkdir(path.join(root,SKILL_JOURNAL_DIRECTORY),{recursive:true});
        await fs.mkdir(path.join(root,'project-audit'),{recursive:true});
        if(after!==null){await fs.writeFile(path.join(root,'project-audit/helper.md'),after);}
        const filename=path.join(root,SKILL_JOURNAL_DIRECTORY,hash('project-audit')+'.json');
        await fs.writeFile(filename,JSON.stringify(journal));return {journal,filename};
    };
    beforeEach(async () => { root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-skill-audit-')); vi.stubEnv('NODE_ENV','production'); vi.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined); });
    afterEach(async () => { for(const item of opened.splice(0)){await item.onModuleDestroy();} vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true}); });

    it('CRUD пишет сводки с исполнителем, без текста и ресурсов; no-op не создаёт событие', async () => {
        const events:ISkillAuditEvent[]=[];const store=storage(async items=>{events.push(...items);});const service=new SkillsService(store);
        const created=await service.createSkill({...input,resources:[{path:'assets/secret.txt',content:'Приватный ресурс'}]},'user-id',actor);
        await service.updateSkill(created.path,{expectedVersion:1,body:input.body},'user-id',actor);
        const updated=await service.updateSkill(created.path,{expectedVersion:1,body:'Новая инструкция'},'user-id',actor);
        await service.deleteSkill(created.path,actor);
        expect(events.map(event=>event.action)).toEqual(['skill.create','skill.update','skill.delete']);
        expect(events.every(event=>event.actor===actor&&event.source==='editor')).toBe(true);
        expect(events[0].before).toBeNull();expect(events[0].after?.generation).toBe(created.meta.generation);
        expect(events[1].before?.version).toBe(1);expect(events[1].after?.version).toBe(2);expect(events[2].after).toBeNull();
        expect(JSON.stringify(events)).not.toContain('Приват');expect(JSON.stringify(events)).not.toContain('Новая инструкция');
        expect(created.audit).toBeUndefined();expect(updated.audit).toBeUndefined();expect(await files()).toEqual([]);
    });
    it('Смешанный sync отмечает создание, изменение и удаление; повтор не меняет UUID и историю', async () => {
        const events:ISkillAuditEvent[]=[];const store=storage(async items=>{events.push(...items);});const service=new SkillsService(store);
        await service.syncSkills('audit',[{slug:'one',name:'Первый',body:'Первый'},{slug:'old',name:'Старый',body:'Старый'}],actor);
        const next=[{slug:'one',name:'Первый',body:'Изменён',version:1},{slug:'new',name:'Новый',body:'Новый'}];
        await service.syncSkills('audit',next,actor);const current=await service.getSkill('project-audit/one');
        const ids=events.map(event=>event.id);await service.syncSkills('audit',[{...next[0],version:2},next[1]],actor);
        expect(events.map(event=>event.id)).toEqual(ids);expect(events.slice(2).map(event=>event.action)).toEqual(['skill.update','skill.create','skill.delete']);
        expect(events.every(event=>event.actor===actor&&event.source==='sync')).toBe(true);expect(current.meta.history.at(-1)?.author).toBe('mcp-sync');
    });
    it('Потерянный ACK оставляет успешный файл и повторяет прежний UUID без повторного изменения', async () => {
        const attempts:ISkillAuditEvent[][]=[];let fail=true;
        const store=storage(async events=>{attempts.push(events);if(fail){throw new Error('ACK потерян');}});const service=new SkillsService(store);
        const result=await service.createSkill(input,'user-id',actor);expect(result.audit).toEqual({state:'pending'});
        const before=await fs.readFile(path.join(root,'project-audit/helper.md'),'utf8');expect(await store.pendingAudit(result.path)).toBe(true);
        expect(await store.pendingAudit('other/helper')).toBe(false);await expect(new AppController(store).ready()).rejects.toMatchObject({status:503});
        const marker=path.join(root,SKILL_JOURNAL_DIRECTORY,(await files())[0]);expect((await fs.stat(marker)).mode&0o777).toBe(0o600);
        fail=false;await store.flushSkillAudit();expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
        expect(await fs.readFile(path.join(root,'project-audit/helper.md'),'utf8')).toBe(before);expect(await store.pendingAudit()).toBe(false);
        await expect(new AppController(store).ready()).resolves.toMatchObject({ok:true});
    });
    it('Недоступный аудит не блокирует последующие изменения той же коллекции и корректно отмечает удаление', async () => {
        const store=storage(async()=>{throw new Error('Каталог отключён');});const service=new SkillsService(store);
        const created=await service.createSkill(input,'id',actor);const updated=await service.updateSkill(created.path,{body:'Версия 2'},'id',actor);
        const removed=await service.deleteSkill(created.path,actor);expect([created,updated,removed].map(item=>item.audit)).toEqual(Array(3).fill({state:'pending'}));
        expect(await files()).toHaveLength(3);await expect(service.getSkill(created.path)).rejects.toMatchObject({status:404});
    });
    it.each([0,7])('Сохранение не ждёт медленный ACK и %s старых журналов',async backlog=>{
        let offline=true;let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
        const delivered:ISkillAuditEvent[]=[];const store=storage(async events=>{if(offline){throw new Error('Нет аудита');}entered();await hold;delivered.push(...events);});const service=new SkillsService(store);
        for(let index=0;index<backlog;index++){await service.createSkill({...input,slug:'old-'+index},'id',actor);}
        offline=false;let deadline:ReturnType<typeof setTimeout>|undefined;
        try{
            const saving=service.createSkill(input,'id',actor);await started;
            expect(await fs.readFile(path.join(root,'project-audit/helper.md'),'utf8')).toContain(input.body);
            const saved=await Promise.race([saving,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Сохранение ждёт всю очередь аудита')),1500);})]);
            expect(saved.audit).toEqual({state:'pending'});expect(await store.pendingAudit(saved.path)).toBe(true);
            expect(await files()).toHaveLength(backlog+1);expect(delivered).toEqual([]);
        }finally{if(deadline){clearTimeout(deadline);}release();await store.flushSkillAudit();}
        expect(delivered).toHaveLength(backlog+1);expect(await files()).toEqual([]);
    });
    it('Пакет из 201 события возвращает pending, пока вторая часть ждёт ACK',async()=>{
        let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const delivered:ISkillAuditEvent[]=[];
        const store=storage(async events=>{if(events.length===1){entered();await hold;}delivered.push(...events);});const service=new SkillsService(store);let deadline:ReturnType<typeof setTimeout>|undefined;
        try{
            const saving=service.syncSkills('slow-many',Array.from({length:201},(_,index)=>({slug:'item-'+index,name:'Скилл '+index,body:'Текст'})),actor);await started;
            const saved=await Promise.race([saving,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Ответ ждёт второй пакет аудита')),1500);})]);
            expect(saved.audit).toEqual({state:'pending'});expect(delivered).toHaveLength(200);expect(await files()).toHaveLength(1);
        }finally{if(deadline){clearTimeout(deadline);}release();await store.flushSkillAudit();}
        expect(delivered).toHaveLength(201);expect(await files()).toEqual([]);
    },30000);
    it('Prepared откатывает файлы и никогда не отправляет подготовленные события', async () => {
        const {journal}=await fixture('prepared');const deliver=vi.fn(async()=>undefined);const store=storage(deliver);await store.init();
        expect(await fs.readFile(path.join(root,'project-audit/helper.md'),'utf8')).toBe(journal.changes[0].before);expect(deliver).not.toHaveBeenCalled();expect(await files()).toEqual([]);
    });
    it.each([false,true])('Committed при старте только доставляет событие; сохранённое удаление=%s не выполняется повторно', async deleted => {
        const {journal}=await fixture('committed',raw(),deleted?null:raw(2));const deliver=vi.fn(async()=>undefined);const store=storage(deliver);
        const rawWrite=vi.spyOn(fs,'writeFile');await store.init();expect(deliver).toHaveBeenCalledWith(journal.events);
        expect(rawWrite).not.toHaveBeenCalled();expect(await files()).toEqual([]);
        if(deleted){await expect(fs.stat(path.join(root,'project-audit/helper.md'))).rejects.toMatchObject({code:'ENOENT'});}
    });
    it('Сбой второй части повторяет стабильные UUID и не теряет первую уже подтверждённую часть', async () => {
        const attempts:ISkillAuditEvent[][]=[];let fail=true;let release!:()=>void;let entered!:()=>void;
        const hold=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
        const store=storage(async events=>{attempts.push(events);if(fail&&attempts.length===2){entered();await hold;throw new Error('Ошибка SQL');}});
        try{
            const service=new SkillsService(store);const result=await service.syncSkills('many',Array.from({length:201},(_,i)=>({slug:'item-'+i,name:'Скилл '+i,body:'Текст'})),actor);
            expect(result.audit).toEqual({state:'pending'});await started;
            const failed=store.flushSkillAudit();release();await expect(failed).rejects.toThrow('Ошибка SQL');
            expect(attempts.map(items=>items.length)).toEqual([200,1]);expect(await store.pendingAudit()).toBe(true);
            fail=false;await store.flushSkillAudit();
            expect(attempts.map(items=>items.length)).toEqual([200,1,200,1]);expect(attempts[2]).toEqual(attempts[0]);expect(attempts[3]).toEqual(attempts[1]);expect(await files()).toEqual([]);
        }finally{release();}
    },30000);
    it('Повреждённая сводка журнала блокирует старт и не скрывается успешной readiness', async () => {
        const {journal,filename}=await fixture('committed');journal.events![0].after!.sha256='f'.repeat(64);await fs.writeFile(filename,JSON.stringify(journal));
        const deliver=vi.fn(async()=>undefined);const store=storage(deliver);await expect(store.init()).rejects.toThrow('не соответствуют');
        expect(deliver).not.toHaveBeenCalled();expect(await store.pendingAudit()).toBe(true);expect(await files()).toHaveLength(1);
    });
    it('Сбой fsync подготовленного журнала происходит до изменения файла и не оставляет события', async () => {
        const deliver=vi.fn(async()=>undefined);const store=storage(deliver);const original=fs.open.bind(fs);let failed=false;
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
            const handle=await original(...args);if(String(args[0]).includes(SKILL_JOURNAL_DIRECTORY)&&String(args[0]).endsWith('.tmp')&&!failed){failed=true;vi.spyOn(handle,'sync').mockRejectedValueOnce(new Error('Ошибка fsync'));}return handle;
        });
        await expect(new SkillsService(store).createSkill(input,'id',actor)).rejects.toThrow('Ошибка fsync');expect(deliver).not.toHaveBeenCalled();
        await expect(fs.stat(path.join(root,'project-audit/helper.md'))).rejects.toMatchObject({code:'ENOENT'});expect(await files()).toEqual([]);
    });
    it('Ошибка до commit откатывает пакет без события аудита', async () => {
        const events:ISkillAuditEvent[]=[];const store=storage(async items=>{events.push(...items);});const service=new SkillsService(store);await service.createSkill(input,'id',actor);
        const original=fs.rename.bind(fs);vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to).endsWith(hash('project-audit')+'.json')){throw new Error('Ошибка commit');}return original(from,to);});
        await expect(service.updateSkill('project-audit/helper',{body:'Не закреплено'},'id',actor)).rejects.toThrow('Ошибка commit');
        expect((await service.getSkill('project-audit/helper')).body).toBe(input.body);expect(events).toHaveLength(1);expect(await files()).toEqual([]);
    });

    it('После commit ошибка архивизации возвращает сохранённый результат и лечится повтором без записи файла', async () => {
        const events:ISkillAuditEvent[]=[];const store=storage(async items=>{events.push(...items);});const service=new SkillsService(store);
        const original=fs.rename.bind(fs);const failure=vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
            if(String(from).endsWith(hash('project-audit')+'.json')&&String(to).includes('audit-')){throw new Error('Ошибка архивизации');}return original(from,to);
        });
        const saved=await service.createSkill(input,'id',actor);expect(saved.audit).toEqual({state:'pending'});expect(saved.body).toBe(input.body);
        const committed=parseSkillJournal(await fs.readFile(path.join(root,SKILL_JOURNAL_DIRECTORY,hash('project-audit')+'.json'),'utf8'));expect(committed.state).toBe('committed');
        failure.mockRestore();await store.flushSkillAudit();expect(events.map(event=>event.id)).toEqual(committed.events!.map(event=>event.id));expect((await service.getSkill(saved.path)).meta.version).toBe(1);expect(await files()).toEqual([]);
    });
    it('Ошибка удаления после ACK повторяет событие, сохраняя результат операции', async () => {
        const events:ISkillAuditEvent[]=[];const store=storage(async items=>{events.push(...items);});const service=new SkillsService(store);
        const remove=fs.unlink.bind(fs);let fail=true;vi.spyOn(fs,'unlink').mockImplementation(async filename=>{if(fail&&String(filename).includes('audit-')){throw new Error('Ошибка unlink');}return remove(filename);});
        const saved=await service.createSkill(input,'id',actor);expect(saved.audit).toEqual({state:'pending'});expect(events).toHaveLength(1);
        fail=false;await store.flushSkillAudit();expect(events).toHaveLength(2);expect(events[1]).toEqual(events[0]);expect((await service.getSkill(saved.path)).meta.version).toBe(1);
    });
    it('Две установки одного пути возвращают один успех и одно событие, соседние файлы тоже сериализуются', async () => {
        const events:ISkillAuditEvent[]=[];const first=storage(async items=>{events.push(...items);});const second=storage(async items=>{events.push(...items);});const meta=normalizeMeta({generation:randomUUID()},'helper');
        const result=await Promise.all([first.createSkill('project-audit/helper',meta,'Текст',undefined,context),second.createSkill('project-audit/helper',meta,'Текст',undefined,context)]);
        expect(result.sort()).toEqual([false,true]);expect(new Set(events.map(event=>event.id)).size).toBe(1);
        await Promise.all([first.createSkill('project-audit/left',normalizeMeta({},'left'),'Левый',undefined,context),second.createSkill('project-audit/right',normalizeMeta({},'right'),'Правый',undefined,context)]);
        expect(new Set(events.map(event=>event.id)).size).toBe(3);expect(await files()).toEqual([]);
    });
    it('Сканер зависимостей видит ссылки из outbox даже без головы', async () => {
        const store=storage(async()=>{throw new Error('Нет аудита');});const service=new SkillsService(store);
        await service.createSkill({...input,meta:{...input.meta,dependencies:[{kind:'mcp',id:'ai-plug-audit',version:1,manifest:'a'.repeat(64)}]}},'id',actor);
        await fs.unlink(path.join(root,'project-audit/helper.md'));expect(await scanSkillDependencyUsage(root,'ai-plug-audit')).toBe(true);
    });
    it('Контроллер берёт email из доверенного actor, сохраняя отдельный author истории', async () => {
        const events:ISkillAuditEvent[]=[];const controller=new SkillsController(new SkillsService(storage(async items=>{events.push(...items);})));
        const req={headers:{'x-bridge-user-id':'user-123','x-bridge-actor':encodeURIComponent(JSON.stringify({email:'Operator@Example.Test'}))},params:{skillPath:'project-audit/helper'}} as unknown as Request;
        const created=await controller.createSkill(input,req);await controller.updateSkill(req,{body:'Правка'});await controller.deleteSkill(req);
        await controller.syncSkills({projectKey:'actor',skills:[{slug:'helper',name:'Помощник',body:'Sync'}]},req);
        expect(created.meta.history[0].author).toBe('user-123');expect(events.map(event=>event.actor)).toEqual(Array(4).fill(actor));
    });
    it('Доверенный локальный email сохраняется как реальный исполнитель', async () => {
        const events:ISkillAuditEvent[]=[];const controller=new SkillsController(new SkillsService(storage(async items=>{events.push(...items);})));
        const req={headers:{'x-bridge-user-id':'dev-id','x-bridge-actor':encodeURIComponent(JSON.stringify({email:'DEV@localhost'}))}} as unknown as Request;
        await controller.createSkill(input,req);expect(events.map(event=>event.actor)).toEqual(['dev@localhost']);
    });
    it('Повреждённые и неоднозначные actor не становятся исполнителем аудита', async () => {
        const events:ISkillAuditEvent[]=[];const controller=new SkillsController(new SkillsService(storage(async items=>{events.push(...items);})));
        const headers=[undefined,encodeURIComponent('{'),'%invalid',...['missing-at','user@@localhost',' user@localhost','user@localhost ','user@localhost\n','user name@localhost','user@local host','user\n@localhost','user@local\u0000host'].map(email=>encodeURIComponent(JSON.stringify({email})))];
        for(const [index,header] of headers.entries()){
            const req={headers:{'x-bridge-user-id':'dev-id',...(header===undefined?{}:{'x-bridge-actor':header})}} as unknown as Request;
            await controller.createSkill({...input,slug:'invalid-'+index},req);
        }
        expect(events).toHaveLength(headers.length);expect(events.every(event=>event.actor==='skills-service')).toBe(true);
    });
    it('Отложенная архивизация старого commit не перемещает новый prepared той же коллекции', async () => {
        const {journal,filename}=await fixture('committed');const store=storage(async()=>undefined);
        let releaseScope!:()=>void;let entered!:()=>void;const hold=new Promise<void>(resolve=>{releaseScope=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
        const lock=withSkillScope(root,'project-audit',async()=>{entered();await hold;});await started;
        const original=fs.open.bind(fs);let saw!:()=>void;let resume!:()=>void;const seen=new Promise<void>(resolve=>{saw=resolve;});const gate=new Promise<void>(resolve=>{resume=resolve;});let intercepted=false;
        vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await original(...args);if(String(args[0])===filename&&!intercepted){intercepted=true;saw();await gate;}return handle;});
        const flush=store.flushSkillAudit();await seen;
        await fs.rename(filename,path.join(path.dirname(filename),'audit-'+journal.id+'.json'));
        const next={...journal,id:randomUUID(),state:'prepared' as const};await fs.writeFile(filename,JSON.stringify(next));resume();releaseScope();await lock;await flush;
        expect(parseSkillJournal(await fs.readFile(filename,'utf8')).id).toBe(next.id);expect(parseSkillJournal(await fs.readFile(filename,'utf8')).state).toBe('prepared');
    });
});
