import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {FsSkillsStorage} from '../src/storage/fs-skills-storage';
import {SkillsService} from '../src/skills/skills.service';
import {serializeSkillFile} from '../src/storage/frontmatter';
import {SKILL_JOURNAL_DIRECTORY} from '../src/storage/skill-journal';
import {skillAuditEvents} from '../src/storage/skill-audit';

describe('Восстановление пакета скиллов сохраняет внешние правки',()=>{
    let temporary:string;let root:string;let storage:FsSkillsStorage;let service:SkillsService;
    const initial=[{slug:'first',name:'Первый',body:'Первая исходная',version:1},{slug:'second',name:'Второй',body:'Вторая исходная',version:1}];
    beforeEach(async()=>{temporary=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-server-journal-'));root=path.join(temporary,'data');storage=new FsSkillsStorage(root);service=new SkillsService(storage);await service.syncSkills('test',initial);});
    afterEach(async()=>{vi.restoreAllMocks();await fs.rm(temporary,{recursive:true,force:true});});
    it('Внешняя правка блокирует весь откат и остаётся вместе с резервной копией',async()=>{
        const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);vi.spyOn(raw,'writeSkillChecked').mockImplementationOnce(async(relative,meta,body)=>{await write(relative,meta,body);await fs.writeFile(path.join(root,relative+'.md'),serializeSkillFile(meta,'Ручная правка после сбоя'));throw new Error('Ошибка диска');});
        await expect(service.syncSkills('test',initial.map(item=>({...item,version:2,body:'Из MCP'})))).rejects.toMatchObject({status:503,response:{code:'SKILL_DURABILITY_UNCERTAIN'}});
        expect(await fs.readFile(path.join(root,'project-test/first.md'),'utf8')).toContain('Ручная правка после сбоя');expect(await fs.readFile(path.join(root,'project-test/second.md'),'utf8')).toContain(initial[1].body);
        await expect(service.getSkill('project-test/first')).rejects.toMatchObject({status:503});
        expect((await fs.readdir(path.join(root,SKILL_JOURNAL_DIRECTORY))).filter(name=>name.endsWith('.json'))).toHaveLength(1);
        await expect(storage.init()).rejects.toThrow('Автоматический откат остановлен');
        await expect(service.listSkills({})).rejects.toMatchObject({status:503});
    });
    it('Повреждённый путь в журнале не изменяет файл вне хранилища',async()=>{
        const outside=path.join(temporary,'outside.md');await fs.writeFile(outside,'Сохранённый внешний файл');const directory=path.join(root,SKILL_JOURNAL_DIRECTORY);await fs.mkdir(directory,{recursive:true});
        await fs.writeFile(path.join(directory,'0'.repeat(64)+'.json'),JSON.stringify({version:1,id:randomUUID(),state:'prepared',host:os.hostname(),pid:process.pid,changes:[{relative:'../outside.md',before:'Подмена',after:'Сохранённый внешний файл'}]}));
        await expect(storage.init()).rejects.toThrow('Повреждён путь');expect(await fs.readFile(outside,'utf8')).toBe('Сохранённый внешний файл');
    });
    it.each(['prepared','committed'] as const)('Журнал %s с двумя коллекциями сохраняется без восстановления или доставки',async state=>{
        await service.createSkill({path:'common',slug:'other',name:'Другой',body:'Исходная общая',meta:{description:'Описание'}},'editor');
        const paths=['project-test/first','common/other'];
        const changes=await Promise.all(paths.map(async relative=>({relative:relative+'.md',before:serializeSkillFile((await service.getSkill(relative)).meta,'Этот откат запрещён'),after:await fs.readFile(path.join(root,relative+'.md'),'utf8')})));
        const directory=path.join(root,SKILL_JOURNAL_DIRECTORY);
        const filename=path.join(directory,createHash('sha256').update('project-test').digest('hex')+'.json');
        await fs.writeFile(filename,JSON.stringify({version:1,id:randomUUID(),state,host:os.hostname(),pid:process.pid,changes,events:skillAuditEvents(changes,{actor:'operator@example.test',source:'sync'})}));
        const deliver=vi.fn(async()=>undefined);const recovering=new FsSkillsStorage(root,undefined,deliver);
        await expect(recovering.init()).rejects.toThrow('одной коллекции');
        for(const change of changes){expect(await fs.readFile(path.join(root,change.relative),'utf8')).toBe(change.after);}
        expect(deliver).not.toHaveBeenCalled();expect(await fs.readFile(filename,'utf8')).toContain(state);
    });
    it.each(['prepared','committed'] as const)('Журнал %s с хешем другой коллекции блокируется до изменения файла',async state=>{
        const relative='project-test/first.md';const after=await fs.readFile(path.join(root,relative),'utf8');
        const directory=path.join(root,SKILL_JOURNAL_DIRECTORY);const filename=path.join(directory,createHash('sha256').update('another').digest('hex')+'.json');
        await fs.writeFile(filename,JSON.stringify({version:1,id:'legacy-journal',state,host:os.hostname(),pid:process.pid,changes:[{relative,before:serializeSkillFile((await service.getSkill('project-test/first')).meta,'Запрещённая подмена'),after}]}));
        await expect(new FsSkillsStorage(root).init()).rejects.toThrow('не соответствует коллекции');
        expect(await fs.readFile(path.join(root,relative),'utf8')).toBe(after);expect(await fs.readFile(filename,'utf8')).toContain(state);
    });
    it('Второй экземпляр не откатывает пакет живого процесса',async()=>{
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);
        vi.spyOn(raw,'writeSkillChecked').mockImplementationOnce(async(...args)=>{await write(...args);entered();await hold;});
        const syncing=service.syncSkills('test',initial.map(item=>({...item,version:2,body:'Из MCP'})));await started;
        try{await expect(new FsSkillsStorage(root).init()).rejects.toThrow('Журнал скиллов занят');}finally{release();}
        await syncing;expect((await service.getSkill('project-test/first')).body).toBe('Из MCP');expect((await service.getSkill('project-test/second')).body).toBe('Из MCP');
    });
    it('Запись файла в корне восстанавливает hash(имя.md) до планирования нового пакета',async()=>{
        const created=await service.createSkill({path:'',slug:'root-helper',name:'Корневой',body:'До сбоя'},'editor');
        const filename=path.join(root,'root-helper.md');const before=await fs.readFile(filename,'utf8');
        const after=serializeSkillFile({...created.meta,version:2},'Незавершённая версия');await fs.writeFile(filename,after);
        const journalFile=path.join(root,SKILL_JOURNAL_DIRECTORY,createHash('sha256').update('root-helper.md').digest('hex')+'.json');
        await fs.writeFile(journalFile,JSON.stringify({version:1,id:'legacy-root',state:'prepared',host:os.hostname(),pid:process.pid,changes:[{relative:'root-helper.md',before,after}]}));
        const rename=fs.rename.bind(fs);vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to)===journalFile){throw new Error('Отказ нового commit');}return rename(from,to);});
        await expect(storage.writeSkill('root-helper',{...created.meta,version:3},'Новая попытка')).rejects.toThrow('Отказ нового commit');
        expect(await fs.readFile(filename,'utf8')).toBe(before);
        expect(await fs.readdir(path.dirname(journalFile))).toEqual([]);
    });
});
