import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FsSkillsStorage} from '../src/storage/fs-skills-storage';
import {normalizeMeta,serializeSkillFile} from '../src/storage/frontmatter';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)){await fs.rm(root,{recursive:true,force:true});}});
describe('Граница серверного файлового хранилища',()=>{
    const meta=normalizeMeta({name:'Проверочная инструкция'},'helper');
    it('Не читает внешний файл через ссылку с допустимым именем скилла',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-links-'));roots.push(root);const base=path.join(root,'skills');await fs.mkdir(base);
        await fs.writeFile(path.join(root,'private.md'),serializeSkillFile(meta,'Приватная проверочная строка'));await fs.symlink(path.join(root,'private.md'),path.join(base,'helper.md'));
        await expect(new FsSkillsStorage(base).readSkill('helper')).rejects.toThrow(/симлинк/i);
    });
    it.each(['write','create','list','directory'] as const)('Операция %s не проходит через промежуточную ссылку',async operation=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-links-'));roots.push(root);const base=path.join(root,'skills');const outside=path.join(root,'outside');await fs.mkdir(base);await fs.mkdir(outside);await fs.symlink(outside,path.join(base,'project-safe'));
        const storage=new FsSkillsStorage(base);
        const action=operation==='write'?storage.writeSkill('project-safe/helper',meta,'Не записывать'):operation==='create'?storage.createSkill('project-safe/helper',meta,'Не создавать'):operation==='list'?storage.listDir('project-safe'):storage.makeDirectory('project-safe/new');
        await expect(action).rejects.toThrow(/симлинк/i);expect(await fs.readdir(outside)).toEqual([]);
    });
});
