import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {FsSkillsStorage} from '../src/storage/fs-skills-storage';
import {SkillsService} from '../src/skills/skills.service';

describe('Ошибка чтения хранилища не считается пустым каталогом',()=>{
    let root:string;let storage:FsSkillsStorage;let service:SkillsService;
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-storage-fault-'));storage=new FsSkillsStorage(root);service=new SkillsService(storage);await service.createSkill({path:'project-fault',slug:'helper',name:'Помощник',body:'Сохранённая инструкция'},'owner');});
    afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
    it('EIO при обходе останавливает синхронизацию до перезаписи файлов и версий',async()=>{
        vi.spyOn(fs,'readdir').mockRejectedValueOnce(Object.assign(new Error('Ошибка тома'),{code:'EIO'}));
        await expect(service.syncSkills('fault',[{slug:'helper',name:'Помощник',body:'Новая инструкция'}])).rejects.toThrow('Ошибка тома');
        expect((await service.getSkill('project-fault/helper')).body).toBe('Сохранённая инструкция');
    });
    it('Сбой хранилища при старте не запускает повторное создание начальных скиллов',async()=>{
        vi.spyOn(fs,'readdir').mockRejectedValueOnce(Object.assign(new Error('Нет доступа'),{code:'EACCES'}));const write=vi.spyOn(storage,'writeSkill');
        await expect(storage.init()).rejects.toThrow('Нет доступа');expect(write).not.toHaveBeenCalled();
    });
    it('Отсутствующая коллекция по-прежнему читается как пустая',async()=>{expect(await storage.listDir('missing')).toEqual([]);});
});
