import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SkillsService} from '../src/skills/skills.service';
import {validateSkillCreate} from '../src/skills/skill-validation';
import {importedSkillSnapshot,skillCreateFromFile} from '../src/skills/asset-import';
import {FsSkillsStorage} from '../src/storage/fs-skills-storage';
import {normalizeMeta,serializeSkillFile} from '../src/storage/frontmatter';
import type {ISkillUpdateRequest} from '../src/skills/skills.model';

const pin={kind:'mcp' as const,id:'ai-plug-exact',version:3,manifest:'a'.repeat(64)};
const input={path:'project-legacy',slug:'helper',name:'Помощник',body:'Точная инструкция',meta:{description:'Описание',dependencies:[pin]}};
let root:string,storage:FsSkillsStorage,service:SkillsService;
const reserve=vi.fn(),deliver=vi.fn();
beforeEach(async()=>{vi.resetAllMocks();reserve.mockResolvedValue(undefined);deliver.mockResolvedValue(undefined);root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-skill-exact-write-'));storage=new FsSkillsStorage(root,reserve,deliver);service=new SkillsService(storage);});
afterEach(async()=>{vi.restoreAllMocks();await storage.onModuleDestroy();await fs.rm(root,{recursive:true,force:true});});
async function legacy(relative='project-legacy/helper'){
 const meta=normalizeMeta({name:'Старый помощник',scope:relative.startsWith('common/')?'common':'project',projectId:'legacy',version:1,mcp:['old-mcp-name'],plugins:['old-plugin-name'],history:[{version:1,at:'2026-01-01T00:00:00.000Z',author:'platform'}]},'helper');
 const file=path.join(root,relative+'.md'),raw=serializeSkillFile(meta,'Старая инструкция');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,raw);return {file,raw,relative};
}
describe('Новые публикации принимают только точные зависимости',()=>{
 it.each(['mcp','plugins'] as const)('Validator и create отклоняют непустые %s даже вместе с pins до доступа к хранилищу',async field=>{
  const request={...input,meta:{...input.meta,[field]:['unresolved-name']}};expect(()=>validateSkillCreate(request)).toThrow('по имени');
  const exists=vi.spyOn(storage,'existsSkill'),write=vi.spyOn(storage,'createSkill');await expect(service.createSkill(request,'editor')).rejects.toMatchObject({status:400});expect(exists).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();
 });
 it('Создаёт новый скилл с exact pins; read projection не меняет canonical hash/payload',async()=>{
  const created=await service.createSkill(input,'editor');expect(created.meta.dependencies).toEqual([pin]);expect(created.meta.mcp).toEqual([]);expect(created.meta.plugins).toEqual([]);
  expect(skillCreateFromFile(created)).toEqual(validateSkillCreate({path:input.path,slug:input.slug,name:created.meta.name,body:created.body,meta:created.meta,resources:created.resources}));
  expect(reserve).toHaveBeenCalled();
 });
 it('Скилл без требований допускает пустые списки без выдуманного pin',async()=>{
  const created=await service.createSkill({...input,meta:{description:'Описание',mcp:[],plugins:[]}},'editor');expect(created.meta.dependencies).toBeUndefined();expect(created.meta.mcp).toEqual([]);
 });
 it('Sync проверяет весь входной пакет до listDir и любой записи',async()=>{
  const read=vi.spyOn(storage,'listDir'),write=vi.spyOn(storage,'applySkillChanges');await expect(service.syncSkills('legacy',[{slug:'first',name:'Первый',body:'Текст'},{slug:'second',name:'Второй',body:'Текст',mcp:['old-name'],dependencies:[pin]}])).rejects.toMatchObject({status:400});
  expect(read).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();
 });
 it('Update не может добавить новые требования по имени к корректному скиллу',async()=>{
  const created=await service.createSkill(input,'editor'),before=await fs.readFile(path.join(root,created.path+'.md'),'utf8'),write=vi.spyOn(storage,'writeSkill');reserve.mockClear();
  await expect(service.updateSkill(created.path,{meta:{plugins:['unresolved-name'],dependencies:[pin]}},'editor')).rejects.toMatchObject({status:400});expect(write).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();expect(await fs.readFile(path.join(root,created.path+'.md'),'utf8')).toBe(before);
 });
});
describe('Старые записи читаются и исправляются только явным решением',()=>{
 it.each([{}, {body:'Новый текст'}, {meta:{description:'Новое описание'}}, {meta:{mcp:[],plugins:[]}}, {meta:{dependencies:[pin]}}, {meta:{mcp:[],dependencies:[pin]}}, {meta:{mcp:[],plugins:[],dependencies:'head'}}] as ISkillUpdateRequest[])('Update %j не очищает старые требования молча и не пишет историю',async request=>{
  const old=await legacy(),write=vi.spyOn(storage,'writeSkill');await expect(service.updateSkill(old.relative,request,'editor')).rejects.toMatchObject({status:400});expect(write).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();expect(await fs.readFile(old.file,'utf8')).toBe(old.raw);
 });
 it.each([{dependencies:[]},{dependencies:[pin]}])('Явная замена на %j сохраняет точную старую версию, не создавая историю из сегодняшнего head',async({dependencies})=>{
  const old=await legacy(),updated=await service.updateSkill(old.relative,{expectedVersion:1,meta:{mcp:[],plugins:[],dependencies}},'editor');
  expect(updated.meta.version).toBe(2);expect(updated.meta.mcp).toEqual([]);expect(updated.meta.plugins).toEqual([]);expect(updated.meta.dependencies??[]).toEqual(dependencies);
  const previous=await service.getSkill(old.relative,1);expect(previous.body).toBe('Старая инструкция');expect(previous.meta.mcp).toEqual(['old-mcp-name']);expect(previous.meta.plugins).toEqual(['old-plugin-name']);
 });
 it('Sync старой записи без явных replacement pins не публикует очищенные требования',async()=>{
  const old=await legacy(),write=vi.spyOn(storage,'applySkillChanges');await expect(service.syncSkills('legacy',[{slug:'helper',name:'Старый помощник',body:'Новая инструкция',version:1}])).rejects.toMatchObject({status:400});expect(write).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();expect(await fs.readFile(old.file,'utf8')).toBe(old.raw);
 });
 it('Sync с явными empty fields и exact dependencies создаёт одну версию и сохраняет старый текст',async()=>{
  const old=await legacy();await service.syncSkills('legacy',[{slug:'helper',name:'Старый помощник',body:'Новая инструкция',version:1,mcp:[],plugins:[],dependencies:[pin]}]);const current=await service.getSkill(old.relative);expect(current.meta.version).toBe(2);expect(current.meta.dependencies).toEqual([pin]);expect(current.meta.mcp).toEqual([]);expect((await service.getSkill(old.relative,1)).meta.mcp).toEqual(['old-mcp-name']);
 });
 it('Read и безопасное удаление старого проектного скилла сохраняют его историю',async()=>{
  const old=await legacy();expect((await service.getSkill(old.relative)).meta.mcp).toEqual(['old-mcp-name']);await service.deleteSkill(old.relative);await expect(fs.access(old.file)).rejects.toMatchObject({code:'ENOENT'});expect(await fs.readdir(root)).toContain('.neurocenter-skill-versions');
 });
 it('Legacy common без description можно проверить и архивировать; возврат требует явного исправления',async()=>{
  const old=await legacy('common/helper'),current=await service.getSkill(old.relative),inspected=await service.inspectAssetSkill(old.relative);expect(inspected.hash).toBe(importedSkillSnapshot(current).hash);
  const archived=await service.archiveAssetSkill(old.relative,inspected,'admin@example.test');expect(archived.meta.archivedAt).toBeTruthy();expect((await service.getSkill(old.relative,1)).meta.mcp).toEqual(['old-mcp-name']);
  await expect(service.archiveAssetSkill(old.relative,importedSkillSnapshot(archived),'admin@example.test',true)).rejects.toMatchObject({status:400});
  const repaired=await service.updateSkill(old.relative,{expectedVersion:2,meta:{description:'Исправленное описание',mcp:[],plugins:[],dependencies:[pin]}},'admin');
  const restored=await service.archiveAssetSkill(old.relative,importedSkillSnapshot(repaired),'admin@example.test',true);expect(restored.meta.version).toBe(4);expect(restored.meta.archivedAt).toBeUndefined();expect(restored.meta.dependencies).toEqual([pin]);
 });
 it('Копия старого head через create остаётся новой строгой публикацией',async()=>{
  const old=await legacy(),file=await service.getSkill(old.relative);await expect(service.createSkill({path:'project-legacy',slug:'copied',name:file.meta.name,body:file.body,meta:{...file.meta,description:'Описание'}},'editor')).rejects.toMatchObject({status:400});await expect(fs.access(path.join(root,'project-legacy/copied.md'))).rejects.toMatchObject({code:'ENOENT'});
 });
});
