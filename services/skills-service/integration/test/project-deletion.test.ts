import 'reflect-metadata';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InternalProjectSkillsController } from '../../src/skills/internal-project-skills.controller';
import { SkillsService } from '../../src/skills/skills.service';
import { FsSkillsStorage } from '../../src/storage/fs-skills-storage';
import { SKILL_VERSIONS_DIRECTORY } from '../../src/storage/skill-versions';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Полное удаление скиллов проекта (Entry 5.11)', () => {
    const token = '1'.repeat(64);
    let root: string;
    let original: string | undefined;
    let storage: FsSkillsStorage;
    let controller: InternalProjectSkillsController;
    const request = (supplied: unknown = token) =>
        ({ headers: { 'x-neurocenter-internal': supplied } }) as unknown as Request;
    const service = () => new SkillsService(storage);

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-project-deletion-'));
        original = process.env.NEUROCENTER_INTERNAL_TOKEN;
        process.env.NEUROCENTER_INTERNAL_TOKEN = token;
        storage = new FsSkillsStorage(root, undefined, async () => undefined);
        await storage.init();
        controller = new InternalProjectSkillsController(storage);
    });

    afterEach(async () => {
        if (original === undefined) {
            delete process.env.NEUROCENTER_INTERNAL_TOKEN;
        } else {
            process.env.NEUROCENTER_INTERNAL_TOKEN = original;
        }
        await storage.onModuleDestroy();
        await fs.rm(root, { recursive: true, force: true });
    });

    it('удаляет каталог проекта, снимки версий и журнал области, не трогая общие скиллы', async () => {
        await service().createSkill(
            {
                path: 'common',
                slug: 'common-skill',
                name: 'Общий',
                body: 'Общая инструкция',
                meta: { description: 'общий' },
            },
            'dev@localhost',
        );
        await service().syncSkills('prj-x', [
            { name: 'Первый', slug: 'first', body: 'v1' },
            { name: 'Второй', slug: 'second', body: 'v1' },
        ]);
        await service().syncSkills('prj-x', [
            { name: 'Первый', slug: 'first', body: 'v2' },
            { name: 'Второй', slug: 'second', body: 'v1' },
        ]);
        const versionDir = path.join(root, SKILL_VERSIONS_DIRECTORY, sha256('project-prj-x/first'));
        expect(await fs.stat(versionDir)).toBeTruthy();

        const result = await controller.delete(request(), { projectId: 'prj-x', actor: 'admin' });
        expect(result.deleted).toBe(true);
        expect(result.skills).toBe(2);
        await expect(fs.stat(path.join(root, 'project-prj-x'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.stat(versionDir)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await service().listSkills({})).map((item) => item.path)).toEqual(['common/common-skill']);
    });

    it('удаляет вложенные скиллы каталога проекта', async () => {
        await service().createSkill(
            { path: 'project-prj-y/sub', slug: 'deep', name: 'Вложенный', body: 'Глубокая инструкция' },
            'dev@localhost',
        );
        const result = await controller.delete(request(), { projectId: 'prj-y', actor: 'admin' });
        expect(result).toEqual({ deleted: true, skills: 1, actor: 'admin' });
        await expect(fs.stat(path.join(root, 'project-prj-y'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('пустой каталог проекта: deleted=false и повторный вызов 404', async () => {
        await fs.mkdir(path.join(root, 'project-prj-empty'));
        expect(await controller.delete(request(), { projectId: 'prj-empty', actor: 'admin' })).toEqual({
            deleted: false,
            skills: 0,
            actor: 'admin',
        });
        await expect(controller.delete(request(), { projectId: 'prj-empty', actor: 'admin' })).rejects.toMatchObject({
            status: 404,
        });
    });

    it('отсутствующий каталог: 404', async () => {
        await expect(controller.delete(request(), { projectId: 'missing', actor: 'admin' })).rejects.toMatchObject({
            status: 404,
        });
    });

    it('отказывает без точного токена', async () => {
        await expect(controller.delete(request(null), { projectId: 'prj-x', actor: 'admin' })).rejects.toMatchObject({
            status: 403,
        });
        await expect(
            controller.delete(request('2'.repeat(64)), { projectId: 'prj-x', actor: 'admin' }),
        ).rejects.toMatchObject({
            status: 403,
        });
        const saved = process.env.NEUROCENTER_INTERNAL_TOKEN;
        delete process.env.NEUROCENTER_INTERNAL_TOKEN;
        try {
            await expect(controller.delete(request(), { projectId: 'prj-x', actor: 'admin' })).rejects.toMatchObject({
                status: 403,
            });
        } finally {
            process.env.NEUROCENTER_INTERNAL_TOKEN = saved;
        }
    });

    it.each(['', 'prj/../../etc', 'PRJ-UPPER', ['prj-x']])(
        'отклоняет некорректный идентификатор проекта: %j',
        async (projectId) => {
            await expect(controller.delete(request(), { projectId, actor: 'admin' })).rejects.toMatchObject({
                status: 400,
            });
        },
    );

    it('ключ common не путается с общим каталогом: 404', async () => {
        await fs.mkdir(path.join(root, 'common'));
        await expect(controller.delete(request(), { projectId: 'common', actor: 'admin' })).rejects.toMatchObject({
            status: 404,
        });
        await expect(fs.stat(path.join(root, 'common'))).resolves.toBeTruthy();
    });

    it('отклоняет отсутствие исполнителя', async () => {
        await expect(controller.delete(request(), { projectId: 'prj-x' })).rejects.toMatchObject({ status: 400 });
        await expect(
            controller.delete(request(), { projectId: 'prj-x', actor: 'bad actor\x01' }),
        ).rejects.toMatchObject({
            status: 400,
        });
    });
});
