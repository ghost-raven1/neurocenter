import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { SkillsService } from '../src/skills/skills.service';

describe('Метаданные скиллов', () => {
    let root: string;
    let service: SkillsService;
    beforeEach(async () => { root=await mkdtemp(path.join(tmpdir(),'neurocenter-skills-')); service=new SkillsService(new FsSkillsStorage(root)); });
    afterEach(async () => { await rm(root,{recursive:true,force:true}); });

    it('Сохраняет описание при публикации скилла', async () => {
        const result=await service.createSkill({path:'common',slug:'helper',name:'helper',body:'Инструкция',meta:{description:'Помощник команды'}},'test');
        expect(result.meta.description).toBe('Помощник команды');
        expect(result.body).toBe('Инструкция');
    });

    it('Редактирует описание без изменения инструкции и увеличивает версию', async () => {
        const original=await service.createSkill({path:'common',slug:'helper',name:'helper',body:'Исходная инструкция',meta:{description:'Исходное описание'}},'test');
        const result=await service.updateSkill(original.path,{meta:{description:'Новое описание'}},'test');
        expect(result.meta.description).toBe('Новое описание');
        expect(result.meta.version).toBe(2);
        expect(result.body).toBe(original.body);
    });
    it('Повторная публикация не перезаписывает существующую инструкцию', async () => {
        const input={path:'common',slug:'helper',name:'Помощник',body:'Первая инструкция',meta:{description:'Описание'}};
        await service.createSkill(input,'first');
        await expect(service.createSkill({...input,body:'Чужая инструкция'},'second')).rejects.toMatchObject({status:409});
        expect((await service.getSkill('common/helper')).body).toBe(input.body);
    });
    it('Две одновременные публикации дают одну карточку и конфликт', async () => {
        const input={path:'common',slug:'helper',name:'Помощник',body:'Инструкция',meta:{description:'Описание'}};
        const results=await Promise.allSettled([service.createSkill(input,'first'),service.createSkill({...input,body:'Другая инструкция'},'second')]);
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
        const failed=results.find(result=>result.status==='rejected');
        expect(failed && failed.status==='rejected' && failed.reason.status).toBe(409);
        expect(['Инструкция','Другая инструкция']).toContain((await service.getSkill('common/helper')).body);
    });
    it('Второе параллельное сохранение получает конфликт версии', async () => {
        const original=await service.createSkill({path:'common',slug:'helper',name:'Помощник',body:'Инструкция',meta:{description:'Описание'}},'first');
        const results=await Promise.allSettled([service.updateSkill(original.path,{expectedVersion:1,body:'Версия А'},'first'),service.updateSkill(original.path,{expectedVersion:1,body:'Версия Б'},'second')]);
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
        expect((await service.getSkill(original.path)).meta.version).toBe(2);
    });
    it('Изменение русского названия увеличивает версию, повтор без изменений — нет', async () => {
        const original=await service.createSkill({path:'common',slug:'helper',name:'Помощник',body:'Инструкция',meta:{description:'Описание',tags:['код']}},'first');
        const changed=await service.updateSkill(original.path,{expectedVersion:1,name:'Новый помощник'},'first');
        expect(changed.meta.version).toBe(2);
        expect((await service.updateSkill(original.path,{expectedVersion:2,meta:{tags:['код']}},'first')).meta.version).toBe(2);
    });
    it.each(['common/../helper','common//helper','/common/helper','common\\helper'])('Не изменяет опасный путь молча: %s', async input => { await expect(service.getSkill(input)).rejects.toMatchObject({status:400}); });
    it('Общий скилл требует описание и непустую инструкцию', async () => {
        await expect(service.createSkill({path:'common',slug:'helper',name:'Помощник',body:' '},'first')).rejects.toMatchObject({status:400});
        await expect(service.createSkill({path:'common',slug:'helper',name:'Помощник',body:'Инструкция'},'first')).rejects.toMatchObject({status:400});
    });
    it.each([{name:null},{body:3},{body:null},{meta:[]},{meta:null},{note:{}}])('Неверные типы редактирования не создают версию: %j',async input=>{
        const original=await service.createSkill({path:'common',slug:'helper',name:'Помощник',body:'Инструкция',meta:{description:'Описание'}},'test');
        await expect(service.updateSkill(original.path,input as never,'test')).rejects.toMatchObject({status:400});expect((await service.getSkill(original.path)).meta.version).toBe(1);
    });

});
