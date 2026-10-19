import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { SkillsService } from '../src/skills/skills.service';

const pin = { kind: 'mcp' as const, id: 'ai-plug-example', version: 2, manifest: 'a'.repeat(64) };
const other = { ...pin, kind: 'plugin' as const, id: 'ai-plug-plugin' };
const input = { path: 'common', slug: 'helper', name: 'Помощник', body: 'Инструкция', meta: { description: 'Описание', dependencies: [pin] } };

describe('Точные зависимости скилла', () => {
    let directory: string;
    let service: SkillsService;
    beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'neurocenter-pins-')); service = new SkillsService(new FsSkillsStorage(directory)); });
    afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

    it('Сохраняет точный пакет и старую зависимость после изменения версии', async () => {
        const first = await service.createSkill(input, 'admin');
        const changed = await service.updateSkill(first.path, { expectedVersion: 1, meta: { dependencies: [{ ...pin, version: 3, manifest: 'b'.repeat(64) }] } }, 'admin');
        expect(changed.meta.version).toBe(2);
        expect(changed.meta.dependencies?.[0].version).toBe(3);
        expect((await service.getSkill(first.path, 1)).meta.dependencies).toEqual([pin]);
    });
    it('Правка текста сохраняет pins, явный пустой список удаляет их новой версией', async () => {
        const first = await service.createSkill(input, 'admin');
        const changed = await service.updateSkill(first.path, { expectedVersion: 1, body: 'Другая инструкция' }, 'admin');
        expect(changed.meta.dependencies).toEqual([pin]);
        const cleared = await service.updateSkill(first.path, { expectedVersion: 2, meta: { dependencies: [] } }, 'admin');
        expect(cleared.meta.version).toBe(3); expect(cleared.meta.dependencies).toBeUndefined();
        expect((await service.getSkill(first.path, 2)).meta.dependencies).toEqual([pin]);
    });
    it('Изменение порядка зависимостей и очистка уже пустого списка не создают версию', async () => {
        const first = await service.createSkill({ ...input, meta: { ...input.meta, dependencies: [other, pin] } }, 'admin');
        expect((await service.updateSkill(first.path, { meta: { dependencies: [pin, other] } }, 'admin')).meta.version).toBe(1);
        await service.updateSkill(first.path, { meta: { dependencies: [] } }, 'admin');
        expect((await service.updateSkill(first.path, { meta: { dependencies: [] } }, 'admin')).meta.version).toBe(2);
    });
    it.each([null, 'head', [pin, pin], [{ ...pin, kind: 'skill' }], [{ ...pin, id: 'Помощник' }], [{ ...pin, version: 0 }], [{ ...pin, version: 1.5 }], [{ ...pin, manifest: 'A'.repeat(64) }], [{ ...pin, extra: 'head' }], Array.from({ length: 21 }, (_, i) => ({ ...pin, id: `ai-plug-${i}` }))])('Не публикует неполное или неоднозначное требование: %j', async dependencies => {
        await expect(service.createSkill({ ...input, meta: { ...input.meta, dependencies: dependencies as never } }, 'admin')).rejects.toMatchObject({ status: 400 });
        expect(await new FsSkillsStorage(directory).existsSkill('common/helper')).toBe(false);
    });
    it('Старый sync сохраняет pins, новый sync может явно очистить их', async () => {
        const first = await service.createSkill({ ...input, path: 'project-prj-qa' }, 'admin');
        await service.syncSkills('prj-qa', [{ slug: 'helper', name: input.name, body: 'Текст из MCP', description: 'Описание', version: 1 }]);
        expect((await service.getSkill(first.path)).meta.dependencies).toEqual([pin]);
        await service.syncSkills('prj-qa', [{ slug: 'helper', name: input.name, body: 'Текст из MCP', description: 'Описание', version: 2, dependencies: [] }]);
        const cleared = await service.getSkill(first.path);
        expect(cleared.meta.version).toBe(3); expect(cleared.meta.dependencies).toBeUndefined();
        expect((await service.getSkill(first.path, 2)).meta.dependencies).toEqual([pin]);
    });
});
