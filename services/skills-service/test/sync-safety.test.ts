import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {FsSkillsStorage} from '../src/storage/fs-skills-storage';
import {SkillsService} from '../src/skills/skills.service';
import type {ISkillsSyncItem} from '../src/skills/skills.model';

const directory='project-prj-qa';
const item={slug:'helper',name:'Помощник',body:'Исходная инструкция',version:1};
describe('Сохранность скиллов при синхронизации',()=>{
    let root:string;let storage:FsSkillsStorage;let service:SkillsService;
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-skills-sync-'));storage=new FsSkillsStorage(root);service=new SkillsService(storage);await service.createSkill({path:directory,...item},'test');});
    afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
    it('Неверная карточка в конце пакета не меняет предыдущие скиллы',async()=>{
        await expect(service.syncSkills('prj-qa',[{...item,body:'Новый текст'},{slug:'broken',name:'Нет инструкции'}])).rejects.toMatchObject({status:400});expect((await service.getSkill(directory+'/helper')).body).toBe(item.body);
    });
    it('Пустой источник не удаляет существующие инструкции',async()=>{
        await expect(service.syncSkills('prj-qa',[])).rejects.toMatchObject({status:409});expect((await service.getSkill(directory+'/helper')).body).toBe(item.body);
    });
    it.each([[item,item],[{...item,slug:'nested/helper'}],[null]])('Неверные или повторные идентификаторы отклоняются до записи: %j',async items=>{
        await expect(service.syncSkills('prj-qa',items as ISkillsSyncItem[])).rejects.toMatchObject({status:400});expect((await service.getSkill(directory+'/helper')).body).toBe(item.body);
    });
    it('Старая локальная версия не стирает серверную правку',async()=>{
        await service.updateSkill(directory+'/helper',{expectedVersion:1,body:'Правка в браузере'},'editor');
        await expect(service.syncSkills('prj-qa',[item])).rejects.toMatchObject({status:409});expect((await service.getSkill(directory+'/helper')).meta.version).toBe(2);
    });
    it('Отсутствующая версия не обходит защиту правок редактора',async()=>{
        await service.updateSkill(directory+'/helper',{expectedVersion:1,body:'Правка в браузере'},'editor');
        const withoutVersion={...item,version:undefined};
        await expect(service.syncSkills('prj-qa',[withoutVersion])).rejects.toMatchObject({status:409});expect((await service.getSkill(directory+'/helper')).body).toBe('Правка в браузере');
    });
    it.each(['created','edited'] as const)('Неполный непустой источник не удаляет скилл редактора: %s',async kind=>{
        const missing={...item,slug:'missing',name:'Нет в локальном источнике'};
        if(kind==='created'){await service.createSkill({path:directory,...missing},'editor');}
        else{
            await service.syncSkills('prj-qa',[item,missing]);
            await service.updateSkill(directory+'/missing',{expectedVersion:1,body:'Новая серверная правка'},'editor');
        }
        const before=await fs.readFile(path.join(root,directory,'missing.md'),'utf8');
        await expect(service.syncSkills('prj-qa',[{...item,body:'Этот текст тоже не должен сохраниться'}])).rejects.toMatchObject({status:409});
        expect(await fs.readFile(path.join(root,directory,'missing.md'),'utf8')).toBe(before);
        expect((await service.getSkill(directory+'/helper')).body).toBe(item.body);
    });
    it('Отсутствующий скилл, которым управлял только MCP, удаляется штатно',async()=>{
        await service.syncSkills('prj-qa',[item,{...item,slug:'mcp-only'}]);
        await expect(service.syncSkills('prj-qa',[item])).resolves.toMatchObject({upserted:0,removed:1,total:1});
        await expect(service.getSkill(directory+'/mcp-only')).rejects.toMatchObject({status:404});
    });
    it('Одинаковая карточка без версии не меняет уже согласованный набор',async()=>{
        await service.syncSkills('prj-qa',[item]);const current=await service.getSkill(directory+'/helper');
        const withoutVersion={...item,version:undefined};
        await service.syncSkills('prj-qa',[withoutVersion]);expect((await service.getSkill(directory+'/helper')).meta).toEqual(current.meta);
    });
    it('Изменение повышает версию и сохраняет историю; повтор не создаёт фиктивных изменений',async()=>{
        await service.syncSkills('prj-qa',[{...item,body:'Новый текст'}]);const current=await service.getSkill(directory+'/helper');expect(current.meta.version).toBe(2);expect(current.meta.history).toHaveLength(2);
        await service.syncSkills('prj-qa',[{...item,body:'Новый текст',version:2}]);expect((await service.getSkill(directory+'/helper')).meta).toEqual(current.meta);
    });
    it('Ошибка диска в середине записи возвращает предыдущие файлы',async()=>{
        await service.createSkill({path:directory,...item,slug:'second'},'test');const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);vi.spyOn(raw,'writeSkillChecked').mockImplementationOnce(write).mockRejectedValueOnce(new Error('Ошибка диска'));
        await expect(service.syncSkills('prj-qa',[{...item,body:'Перезапись',version:2},{...item,slug:'second',body:'Другое',version:2}])).rejects.toThrow('Ошибка диска');expect((await service.getSkill(directory+'/helper')).body).toBe(item.body);expect((await service.getSkill(directory+'/second')).body).toBe(item.body);
    });
    it('Синхронизация и редактор не перезаписывают друг друга параллельно',async()=>{
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);
        vi.spyOn(raw,'writeSkillChecked').mockImplementation(async(...args)=>{if(args[2]==='Из MCP'){entered();await hold;}return write(...args);});
        const sync=service.syncSkills('prj-qa',[{...item,version:2,body:'Из MCP'}]);await started;
        const editing=service.updateSkill(directory+'/helper',{expectedVersion:1,body:'Из браузера'},'editor');const checked=expect(editing).rejects.toMatchObject({status:409});release();await sync;await checked;expect((await service.getSkill(directory+'/helper')).body).toBe('Из MCP');
    });
    it.each([false,true])('Чтение инструкции, версии и списка ждёт %s commit всего sync',async committed=>{
        await service.createSkill({path:directory,...item,slug:'second'},'editor');
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
        const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);
        vi.spyOn(raw,'writeSkillChecked').mockImplementationOnce(write).mockImplementationOnce(async(...args)=>{entered();await hold;if(!committed){throw new Error('Ошибка второго файла');}return write(...args);});
        const syncing=service.syncSkills('prj-qa',[{...item,body:'Новая инструкция'},{...item,slug:'second',body:'Вторая новая'}]).then(()=>undefined,error=>error as Error);
        await started;let finished=0;
        const exact=service.getSkill(directory+'/helper',2).then(value=>{finished++;return value;},error=>{finished++;return {status:error.status};});
        const current=service.getSkill(directory+'/helper').then(value=>{finished++;return value;});
        const listing=service.listSkills({path:directory}).then(value=>{finished++;return value;});
        try{await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(0);}finally{release();}
        const syncResult=await syncing;
        if(committed){expect(syncResult).toBeUndefined();expect(await exact).toMatchObject({body:'Новая инструкция',meta:{version:2}});}
        else{expect(syncResult).toMatchObject({message:'Ошибка второго файла'});expect(await exact).toEqual({status:404});}
        expect((await current).body).toBe(committed?'Новая инструкция':item.body);
        expect((await listing).every(file=>file.meta.version===(committed?2:1))).toBe(true);
    });
    it('Незавершённое удаление не отвечает 404 до отката пакета',async()=>{
        await service.createSkill({path:directory,...item,slug:'second'},'editor');
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
        const raw=storage as unknown as {deleteSkillChecked:typeof storage.deleteSkill};const remove=raw.deleteSkillChecked.bind(storage);
        vi.spyOn(raw,'deleteSkillChecked').mockImplementationOnce(remove).mockImplementationOnce(async()=>{entered();await hold;throw new Error('Ошибка второго удаления');});
        const deleting=storage.applySkillChanges([{path:directory+'/helper',next:null},{path:directory+'/second',next:null}]).then(()=>undefined,error=>error as Error);
        await started;await expect(fs.access(path.join(root,directory,'helper.md'))).rejects.toMatchObject({code:'ENOENT'});let finished=0;
        const reading=service.getSkill(directory+'/helper').then(value=>{finished++;return value;},error=>{finished++;return {status:error.status};});
        const exists=storage.existsSkill(directory+'/helper').then(value=>{finished++;return value;});
        try{await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(0);}finally{release();}
        expect(await deleting).toMatchObject({message:'Ошибка второго удаления'});
        expect(await reading).toMatchObject({body:item.body,meta:{version:1}});expect(await exists).toBe(true);
    });
    it('Список и дерево не видят созданный файл пакета, который затем откатился',async()=>{
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
        const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);
        vi.spyOn(raw,'writeSkillChecked').mockImplementationOnce(write).mockImplementationOnce(async()=>{entered();await hold;throw new Error('Ошибка после создания');});
        const syncing=service.syncSkills('prj-qa',[{...item,slug:'phantom'}, {...item,body:'Не сохранять'}]).then(()=>undefined,error=>error as Error);
        await started;await expect(fs.access(path.join(root,directory,'phantom.md'))).resolves.toBeUndefined();let finished=0;
        const listing=service.listSkills({path:directory}).then(value=>{finished++;return value;});
        const tree=service.getTree().then(value=>{finished++;return value;});
        try{await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(0);}finally{release();}
        expect(await syncing).toMatchObject({message:'Ошибка после создания'});
        expect((await listing).map(file=>file.path)).toEqual([directory+'/helper']);
        expect((await tree)[0].children?.map(file=>file.path)).toEqual([directory+'/helper']);
    });
    it('Файл в корне не становится фантомом списка после незавершённого создания',async()=>{
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
        const raw=storage as unknown as {writeSkillChecked:typeof storage.writeSkill};const write=raw.writeSkillChecked.bind(storage);
        vi.spyOn(raw,'writeSkillChecked').mockImplementationOnce(async(...args)=>{await write(...args);entered();await hold;throw new Error('Ошибка создания в корне');});
        const creating=service.createSkill({path:'',...item,slug:'root-phantom'},'editor').then(()=>undefined,error=>error as Error);
        await started;let finished=0;
        const listing=service.listSkills({}).then(value=>{finished++;return value;});
        const tree=service.getTree().then(value=>{finished++;return value;});
        const exists=storage.existsSkill('root-phantom').then(value=>{finished++;return value;});
        try{await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(0);}finally{release();}
        expect(await creating).toMatchObject({message:'Ошибка создания в корне'});
        expect((await listing).map(file=>file.path)).toEqual([directory+'/helper']);
        expect((await tree).map(file=>file.path)).toEqual([directory]);expect(await exists).toBe(false);
    });
    it('Перечень не скрывает ошибку доступа к уже найденному файлу',async()=>{
        const failure=Object.assign(new Error('Нет доступа'),{code:'EACCES'});
        vi.spyOn(storage,'readSkill').mockRejectedValue(failure);
        await expect(service.listSkills({path:directory})).rejects.toBe(failure);
        await expect(service.getTree()).rejects.toBe(failure);
    });
});
