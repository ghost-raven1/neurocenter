import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { SkillsService } from '../src/skills/skills.service';
import { importedSkillSnapshot } from '../src/skills/asset-import';
const input={path:'common',slug:'helper',name:'Помощник',body:'Инструкция',meta:{description:'Полезная инструкция'},resources:[{path:'references/guide.md',content:'Справочник'}]};
const actor='dev@localhost';
describe('Импорт и архив общей карточки скилла',()=>{
 let root:string,storage:FsSkillsStorage,service:SkillsService;
 beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-asset-skill-'));storage=new FsSkillsStorage(root,undefined,async()=>undefined);service=new SkillsService(storage);});
 afterEach(async()=>{vi.restoreAllMocks();await storage.onModuleDestroy();await fs.rm(root,{recursive:true,force:true});});
 it('schema init не импортирует скиллы и сохраняет имеющиеся файлы',async()=>{
  await storage.init();expect(await service.listSkills({})).toEqual([]);
  const first=await service.importAssetSkill(input,randomUUID(),actor);await storage.init();expect(await service.getSkill(first.path)).toEqual(first);
 });
 it('потеря ACK и повтор после restart сохраняют одну версию и ту же генерацию',async()=>{
  const key=randomUUID(),first=await service.importAssetSkill(input,key,actor),reopened=new FsSkillsStorage(root,undefined,async()=>undefined);
  try{const next=await new SkillsService(reopened).importAssetSkill(input,key,actor);expect(importedSkillSnapshot(next)).toEqual(importedSkillSnapshot(first));expect(next.meta.history).toHaveLength(1);}finally{await reopened.onModuleDestroy();}
  await expect(service.importAssetSkill({...input,body:'Подмена'},key,actor)).rejects.toMatchObject({status:409});
 });
 it('одинаковые одновременные intent дают одну версию, чужой create останавливается',async()=>{
  const key=randomUUID(),saved=await Promise.all([service.importAssetSkill(input,key,actor),service.importAssetSkill(input,key,actor)]);
  expect(saved.map(item=>item.meta.version)).toEqual([1,1]);await expect(service.importAssetSkill(input,randomUUID(),actor)).rejects.toMatchObject({status:409});
 });
 it('обновление CAS сохраняет старые ресурсы и историю; no-op не создаёт версию',async()=>{
  const first=await service.importAssetSkill(input,randomUUID(),actor),expected=importedSkillSnapshot(first);
  expect((await service.importAssetSkill(input,randomUUID(),actor,expected)).meta.version).toBe(1);
  const updated=await service.importAssetSkill({...input,body:'Новая инструкция',resources:[]},randomUUID(),actor,expected);
  expect(updated.meta.version).toBe(2);expect((await service.getSkill(first.path,1)).resources).toEqual(input.resources);
  await expect(service.importAssetSkill(input,randomUUID(),actor,expected)).rejects.toMatchObject({status:409});
 });
 it('локальная правка не присваивается квитанции при retry',async()=>{
  const key=randomUUID(),first=await service.importAssetSkill(input,key,actor);await service.updateSkill(first.path,{body:'Локальная правка',expectedVersion:1},actor);
  await expect(service.importAssetSkill(input,key,actor)).rejects.toMatchObject({status:409});await expect(service.importAssetSkill(input,randomUUID(),actor,importedSkillSnapshot(first))).rejects.toMatchObject({status:409});
  expect((await service.getSkill(first.path)).body).toBe('Локальная правка');
 });
 it('архив скрывает head и сохраняет версии/ресурсы; restore возвращает новую версию',async()=>{
  const first=await service.importAssetSkill(input,randomUUID(),actor),archived=await service.archiveAssetSkill(first.path,importedSkillSnapshot(first),actor);
  expect(archived.meta.archivedAt).toBeTruthy();expect(await service.listSkills({})).toEqual([]);expect((await service.getSkill(first.path,1)).resources).toEqual(input.resources);
  await expect(service.importAssetSkill(input,randomUUID(),actor,importedSkillSnapshot(archived))).rejects.toMatchObject({status:409});
  const restored=await service.archiveAssetSkill(first.path,importedSkillSnapshot(archived),actor,true);
  expect(restored.meta.version).toBe(3);expect(restored.meta.archivedAt).toBeUndefined();expect(await service.listSkills({})).toHaveLength(1);
  await expect(service.deleteSkill(first.path,actor)).rejects.toMatchObject({status:409});expect((await service.getSkill(first.path,2)).meta.archivedAt).toBeTruthy();
 });
 it('storage CAS ловит ручную правку с неизменённым номером версии',async()=>{
  const first=await service.importAssetSkill(input,randomUUID(),actor),filename=path.join(root,'common/helper.md'),raw=await fs.readFile(filename,'utf8');await fs.writeFile(filename,raw.replace('Инструкция','Внешняя правка'));
  await expect(storage.writeSkill(first.path,{...first.meta,version:2},'Замена',[],{actor,source:'editor'},first)).rejects.toMatchObject({status:409});expect(await fs.readFile(filename,'utf8')).toContain('Внешняя правка');
 });
 it('отказ записи не подтверждает публикацию и оставляет прежнюю версию',async()=>{
  const first=await service.importAssetSkill(input,randomUUID(),actor);vi.spyOn(fs,'link').mockRejectedValueOnce(Object.assign(new Error('Нет места'),{code:'ENOSPC'}));
  await expect(service.importAssetSkill({...input,body:'Не сохранено'},randomUUID(),actor,importedSkillSnapshot(first))).rejects.toThrow('Нет места');expect((await service.getSkill(first.path)).body).toBe(first.body);
 });
 it.each([{...input,path:'project-test'},{...input,slug:'../escape'},{...input,resources:[{path:'../escape',content:'x'}]}])('невалидный native payload отклоняется до записи',async raw=>{await expect(service.importAssetSkill(raw,randomUUID(),actor)).rejects.toThrow();expect(await service.listSkills({})).toEqual([]);});
});
