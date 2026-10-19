import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { SkillsService } from '../src/skills/skills.service';
import { validateResources } from '../src/skills/skill-resources';

describe('Полные версии скилла с ресурсами', () => {
    let root: string;
    let storage: FsSkillsStorage;
    let service: SkillsService;
    const resource = { path: 'assets/пример.bin', content: Buffer.from([0, 255, 128, 10]).toString('base64'), encoding: 'base64' as const };
    const create = () => service.createSkill({ path: 'project-test', slug: 'helper', name: 'Помощник', body: 'Исходная инструкция', resources: [resource] }, 'author');
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-skill-resources-'));
        storage = new FsSkillsStorage(root); service = new SkillsService(storage);
    });
    afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
    it('Сохраняет бинарный ресурс и выдаёт старую версию после обновления', async () => {
        const first = await create();
        await service.updateSkill(first.path, { expectedVersion: 1, body: 'Новая инструкция', resources: [] }, 'editor');
        const old = await service.getSkill(first.path, 1);
        expect(old.body).toBe(first.body); expect(old.resources).toEqual([resource]);
        expect((await service.getSkill(first.path)).resources).toBeUndefined();
        expect((await service.listSkills({})).map(file => file.path)).toEqual([first.path]);
        const snapshots=(await fs.readdir(root,{recursive:true})).filter(file=>file.startsWith('.neurocenter-skill-versions/'));
        expect(snapshots.some(file=>file.endsWith('.snapshot'))).toBe(true);
        expect(snapshots.some(file=>file.endsWith('.md'))).toBe(false);
    });
    it('Изменение только ресурса повышает версию, отсутствие поля сохраняет ресурсы', async () => {
        const first = await create();
        const same = await service.updateSkill(first.path, { expectedVersion: 1, name: 'Новое название' }, 'editor');
        expect(same.resources).toEqual([resource]);
        const next = await service.updateSkill(first.path, { expectedVersion: 2, resources: [{path:'references/guide.md',content:'Справочник'}] }, 'editor');
        expect(next.meta.version).toBe(3); expect((await service.getSkill(first.path, 2)).resources).toEqual([resource]);
    });
    it('Синхронизация инструкции не теряет опубликованные ресурсы', async () => {
        await create();
        await service.syncSkills('test', [{slug:'helper',name:'Помощник',body:'Из MCP',version:1}]);
        expect((await service.getSkill('project-test/helper')).resources).toEqual([resource]);
        expect((await service.getSkill('project-test/helper', 1)).body).toBe('Исходная инструкция');
    });
    it('Повторное создание не присваивает историю удалённого скилла', async () => {
        const old = await create();
        await service.updateSkill(old.path, {body:'Вторая инструкция'}, 'editor');
        await service.deleteSkill(old.path);
        const fresh = await create();
        expect(fresh.meta.generation).not.toBe(old.meta.generation);
        await service.updateSkill(fresh.path, {body:'Другая вторая'}, 'editor');
        expect((await service.getSkill(fresh.path, 1)).meta.generation).toBe(fresh.meta.generation);
    });
    it('Ошибка сохранения истории не меняет текущую инструкцию', async () => {
        const first = await create();
        vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('Нет места'), {code:'ENOSPC'}));
        await expect(service.updateSkill(first.path, {body:'Новая'}, 'editor')).rejects.toThrow('Нет места');
        expect((await service.getSkill(first.path)).body).toBe(first.body);
    });
    it('Не подменяет недоступную историческую версию текущей', async () => {
        const first = await create();
        await expect(service.getSkill(first.path, 2)).rejects.toThrow('отсутствует');
    });
    it('Удаление между проверкой и чтением возвращает 404 вместо ошибки сервера', async () => {
        const first=await create();
        vi.spyOn(storage,'readSkill').mockRejectedValueOnce(Object.assign(new Error('Удалён параллельно'),{code:'ENOENT'}));
        await expect(service.getSkill(first.path,1)).rejects.toMatchObject({status:404});
    });
    it('Учитывает служебную шапку в лимите устанавливаемой инструкции', async () => {
        await expect(service.createSkill({path:'project-test',slug:'large',name:'Большая инструкция',body:'x'.repeat(1024*1024)},'author')).rejects.toThrow('метаданными');
        expect(await storage.existsSkill('project-test/large')).toBe(false);
    });
    it.each(['../outside', 'assets/../outside', 'scripts/CON.txt', 'assets/a\\b', 'assets/a.', 'assets/' + 'я'.repeat(121)])('Отклоняет опасный путь %s до публикации', async resourcePath => {
        await expect(service.createSkill({path:'project-test',slug:'helper',name:'Помощник',body:'Инструкция',resources:[{path:resourcePath,content:'x'}]}, 'author')).rejects.toThrow();
        expect(await storage.existsSkill('project-test/helper')).toBe(false);
    });
    it('Отклоняет разный регистр, вложенный конфликт и неканонический base64', () => {
        expect(() => validateResources([{path:'assets/A',content:''},{path:'assets/a',content:''}])).toThrow('конфликтуют');
        expect(() => validateResources([{path:'assets/a',content:''},{path:'assets/a/b',content:''}])).toThrow('конфликтуют');
        expect(() => validateResources([{path:'assets/a',content:'Zg',encoding:'base64'}])).toThrow('base64');
    });
});
