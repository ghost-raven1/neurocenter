import fs from 'node:fs/promises';
import { promises as storageFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { SkillsService } from '../src/skills/skills.service';
import { SkillsController } from '../src/skills/skills.controller';
import { skillDirectoryAuditEvents, type TDeliverSkillAudit } from '../src/storage/skill-audit';
import { SKILL_JOURNAL_DIRECTORY, type ISkillJournal } from '../src/storage/skill-journal';
import { scanSkillDependencyUsage } from '../src/storage/skill-dependency-usage';
import type { ISkillAuditEvent } from '../../shared/skill-audit.cjs';

const actor = 'operator@example.test';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Устойчивый аудит создания папок скиллов', () => {
    let root: string;
    const opened: FsSkillsStorage[] = [];
    const store = (deliver: TDeliverSkillAudit) => {
        const item = new FsSkillsStorage(root, undefined, deliver); opened.push(item); return item;
    };
    const journalFiles = () => fs.readdir(path.join(root, SKILL_JOURNAL_DIRECTORY));
    const fixture = async (state: 'prepared' | 'committed', present = true) => {
        const relative = 'recover/parent/leaf';
        const journal: ISkillJournal = { version: 1, id: randomUUID(), state, host: os.hostname(), pid: process.pid,
            changes: [{kind:'directory',relative,before:null,after:'directory',createdDirectories:['recover','recover/parent',relative]}],
            events: skillDirectoryAuditEvents(relative, actor) };
        if (present) { await fs.mkdir(path.join(root, relative), {recursive:true}); }
        const directory = path.join(root, SKILL_JOURNAL_DIRECTORY); await fs.mkdir(directory, {recursive:true});
        const filename = path.join(directory, hash('recover')+'.json');
        await fs.writeFile(filename, JSON.stringify(journal));
        return {journal,filename,relative};
    };
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-folder-audit-'));
        vi.stubEnv('NODE_ENV','production'); vi.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
    });
    afterEach(async () => {
        for (const item of opened.splice(0)) { await item.onModuleDestroy(); }
        vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root,{recursive:true,force:true});
    });

    it('Вложенный путь пишет одно событие явно запрошенной папки и доверенный email', async () => {
        const events: ISkillAuditEvent[] = []; const storage = store(async batch=>{events.push(...batch);});
        const controller = new SkillsController(new SkillsService(storage));
        const req = {headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:'Operator@Example.Test'}))}} as unknown as Request;
        const result = await controller.createDirectory({path:'common/parent/leaf',actor:'forged@example.test'} as never,req);
        expect(result).toEqual({ok:true,path:'common/parent/leaf'});
        expect((await fs.stat(path.join(root,result.path))).isDirectory()).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({actor,action:'skill.directory.create',source:'editor',resourceId:result.path,before:null,after:{directory:true}});
        expect(await journalFiles()).toEqual([]);
        await controller.createDirectory({path:result.path},req);
        expect(events).toHaveLength(1);
    });
    it('Существовавшая до запроса папка остаётся без фиктивного события', async () => {
        await fs.mkdir(path.join(root,'existing')); const deliver = vi.fn(async()=>undefined);
        await new SkillsService(store(deliver)).createDirectory('existing',actor);
        expect(deliver).not.toHaveBeenCalled(); expect(await fs.readdir(root)).toEqual(['existing']);
    });
    it('Потерянный ACK сохраняет папку и повторяет прежний UUID без нового mkdir', async () => {
        const attempts: ISkillAuditEvent[][] = []; let fail = true;
        const storage = store(async events=>{attempts.push(events);if(fail){throw new Error('ACK потерян');}});
        const service = new SkillsService(storage);
        const first = await service.createDirectory('common/pending',actor);
        const mkdir = vi.spyOn(fs,'mkdir');
        const repeat = await service.createDirectory('common/pending',actor);
        expect(first.audit).toEqual({state:'pending'}); expect(repeat.audit).toEqual({state:'pending'});
        expect(mkdir).not.toHaveBeenCalled(); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
        fail = false; await storage.flushSkillAudit();
        expect(attempts[2]).toEqual(attempts[0]); expect(await storage.pendingAudit('common/pending')).toBe(false);
        expect((await fs.stat(path.join(root,'common/pending'))).isDirectory()).toBe(true);
    });
    it('Медленный ACK возвращает успешный pending за ограниченное ожидание', async () => {
        let release!:()=>void; const hold = new Promise<void>(resolve=>{release=resolve;});
        const storage = store(async()=>{await hold;}); let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([new SkillsService(storage).createDirectory('common/slow',actor),new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Ответ ждёт аудит')),1500);})]);
            expect(result.audit).toEqual({state:'pending'}); expect(await storage.pendingAudit(result.path)).toBe(true);
            expect((await fs.stat(path.join(root,result.path))).isDirectory()).toBe(true);
        } finally { if(deadline){clearTimeout(deadline);} release(); await storage.flushSkillAudit(); }
        expect(await journalFiles()).toEqual([]);
    });
    it('Два экземпляра не создают два разных события для одной папки', async () => {
        const events: ISkillAuditEvent[] = []; const deliver = async(batch:ISkillAuditEvent[])=>{events.push(...batch);};
        await Promise.all([new SkillsService(store(deliver)).createDirectory('common/one',actor),new SkillsService(store(deliver)).createDirectory('common/one',actor)]);
        expect(new Set(events.map(event=>event.id)).size).toBe(1); expect(await journalFiles()).toEqual([]);
    });
    it.each(['','../outside','common/../outside','common\\child','common//child'])('Некорректный путь %s не меняет файловую систему', async relative => {
        const deliver = vi.fn(async()=>undefined);
        await expect(new SkillsService(store(deliver)).createDirectory(relative,actor)).rejects.toMatchObject({status:400});
        expect(await fs.readdir(root)).toEqual([]); expect(deliver).not.toHaveBeenCalled();
    });
    it.each([null,undefined,[]])('Некорректное тело %j возвращает 400', async body => {
        const controller = new SkillsController(new SkillsService(store(async()=>undefined)));
        expect(()=>controller.createDirectory(body as never)).toThrow('Передайте путь');
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('Файл вместо промежуточной папки отклоняется до журнала и mkdir', async () => {
        await fs.writeFile(path.join(root,'occupied'),'Не трогать'); const deliver = vi.fn(async()=>undefined);
        await expect(new SkillsService(store(deliver)).createDirectory('occupied/child',actor)).rejects.toThrow('другим типом');
        expect(await fs.readFile(path.join(root,'occupied'),'utf8')).toBe('Не трогать');
        expect(await fs.readdir(root)).toEqual(['occupied']); expect(deliver).not.toHaveBeenCalled();
    });
    it('Ошибка mkdir удаляет только новые пустые родители и не отправляет событие', async () => {
        await fs.mkdir(path.join(root,'common')); const deliver = vi.fn(async()=>undefined); const mkdir = storageFs.mkdir.bind(storageFs); const physicalRoot=await fs.realpath(root);
        vi.spyOn(storageFs,'mkdir').mockImplementation(async(...args:Parameters<typeof storageFs.mkdir>)=>{if(String(args[0])===path.join(physicalRoot,'common/new/leaf')){throw new Error('Отказ mkdir');}return mkdir(...args);});
        await expect(new SkillsService(store(deliver)).createDirectory('common/new/leaf',actor)).rejects.toThrow('Отказ mkdir');
        expect(await fs.readdir(path.join(root,'common'))).toEqual([]); expect(await journalFiles()).toEqual([]); expect(deliver).not.toHaveBeenCalled();
    });
    it('Ошибка commit откатывает новые папки без события', async () => {
        const deliver = vi.fn(async()=>undefined); const rename = fs.rename.bind(fs);
        vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to).endsWith(hash('common')+'.json')){throw new Error('Отказ commit');}return rename(from,to);});
        await expect(new SkillsService(store(deliver)).createDirectory('common/new',actor)).rejects.toThrow('Отказ commit');
        await expect(fs.stat(path.join(root,'common'))).rejects.toMatchObject({code:'ENOENT'});
        expect(await journalFiles()).toEqual([]); expect(deliver).not.toHaveBeenCalled();
    });
    it('Ошибка архивизации после commit возвращает pending и доставляется повтором', async () => {
        const events: ISkillAuditEvent[] = []; const storage = store(async batch=>{events.push(...batch);}); const rename = fs.rename.bind(fs);
        const failure = vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(from).endsWith(hash('common')+'.json')&&String(to).includes('audit-')){throw new Error('Отказ archive');}return rename(from,to);});
        const result = await new SkillsService(storage).createDirectory('common/new',actor);
        expect(result.audit).toEqual({state:'pending'}); expect(events).toEqual([]);
        const journal = JSON.parse(await fs.readFile(path.join(root,SKILL_JOURNAL_DIRECTORY,hash('common')+'.json'),'utf8')) as ISkillJournal;
        failure.mockRestore(); await storage.flushSkillAudit();
        expect(events.map(event=>event.id)).toEqual(journal.events!.map(event=>event.id)); expect(await journalFiles()).toEqual([]);
    });
    it.each([false,true])('Prepared после частичного mkdir=%s откатывается без аудита', async complete => {
        const {relative} = await fixture('prepared',complete);
        if(!complete){await fs.mkdir(path.join(root,'recover/parent'),{recursive:true});}
        const deliver = vi.fn(async()=>undefined); await store(deliver).init();
        await expect(fs.stat(path.join(root,relative.split('/')[0]))).rejects.toMatchObject({code:'ENOENT'});
        expect(deliver).not.toHaveBeenCalled(); expect(await journalFiles()).toEqual([]);
    });
    it('Prepared с посторонним содержимым не удаляет ни одной папки', async () => {
        const {filename,relative} = await fixture('prepared'); await fs.writeFile(path.join(root,relative,'manual.txt'),'Ручные данные');
        const rmdir = vi.spyOn(fs,'rmdir'); const deliver = vi.fn(async()=>undefined);
        await expect(store(deliver).init()).rejects.toThrow('Автоматический откат остановлен');
        expect(rmdir).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(root,relative,'manual.txt'),'utf8')).toBe('Ручные данные');
        expect(await fs.readFile(filename,'utf8')).toContain('prepared'); expect(deliver).not.toHaveBeenCalled();
    });
    it('Подменённый симлинком компонент блокирует восстановление', async () => {
        const {filename,relative} = await fixture('prepared'); await fs.rmdir(path.join(root,relative));
        await fs.mkdir(path.join(root,'outside')); await fs.writeFile(path.join(root,'outside/keep.txt'),'Сохранить');
        await fs.symlink(path.join(root,'outside'),path.join(root,relative)); const deliver = vi.fn(async()=>undefined);
        await expect(store(deliver).init()).rejects.toThrow();
        expect(await fs.readFile(path.join(root,'outside/keep.txt'),'utf8')).toBe('Сохранить');
        expect(await fs.readFile(filename,'utf8')).toContain('prepared'); expect(deliver).not.toHaveBeenCalled();
    });
    it('Повреждённый список родителей сохраняет журнал и текущие папки', async () => {
        const {journal,filename,relative} = await fixture('prepared');
        journal.changes[0] = {...journal.changes[0],createdDirectories:['recover','another']} as never;
        await fs.writeFile(filename,JSON.stringify(journal)); const deliver = vi.fn(async()=>undefined);
        await expect(store(deliver).init()).rejects.toThrow('список создаваемых');
        expect((await fs.stat(path.join(root,relative))).isDirectory()).toBe(true); expect(deliver).not.toHaveBeenCalled();
    });
    it.each([false,true])('Committed только доставляет прежнее событие, существование папки=%s не переигрывает mkdir', async present => {
        const {journal,relative} = await fixture('committed',present); const events: ISkillAuditEvent[] = []; const storage = store(async batch=>{events.push(...batch);});
        await storage.init(); expect(events).toEqual(journal.events); expect(await journalFiles()).toEqual([]);
        if(!present){await expect(fs.stat(path.join(root,relative))).rejects.toMatchObject({code:'ENOENT'});}
    });
    it('Сканер зависимостей понимает папочный outbox и не считает его повреждённым файлом', async () => {
        const storage = store(async()=>{throw new Error('Нет аудита');}); await new SkillsService(storage).createDirectory('common/new',actor);
        expect(await scanSkillDependencyUsage(root,'ai-plug-unused')).toBe(false);
    });
    it('Корневой перечень ждёт rollback новой коллекции и не возвращает фантомную папку', async () => {
        const storage = store(async()=>undefined); const service = new SkillsService(storage); const mkdir = storageFs.mkdir.bind(storageFs); const physicalRoot=await fs.realpath(root);
        let entered!:()=>void; const started = new Promise<void>(resolve=>{entered=resolve;}); let release!:()=>void; const hold = new Promise<void>(resolve=>{release=resolve;});
        vi.spyOn(storageFs,'mkdir').mockImplementation(async(...args:Parameters<typeof storageFs.mkdir>)=>{const result=await mkdir(...args);if(String(args[0])===path.join(physicalRoot,'new-collection/leaf')){entered();await hold;throw new Error('Отказ после mkdir');}return result;});
        const creating = service.createDirectory('new-collection/leaf',actor).then(()=>undefined,error=>error as Error); await started; let finished=false;
        const tree = service.getTree().then(value=>{finished=true;return value;});
        try{await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(false);}finally{release();}
        expect(await creating).toMatchObject({message:'Отказ после mkdir'}); expect(await tree).toEqual([]);
    });
});
