import 'reflect-metadata';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillDependenciesController } from '../src/skills/skill-dependencies.controller';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { normalizeMeta } from '../src/storage/frontmatter';

describe('Внутренняя проверка зависимостей скиллов', () => {
    const assetId = 'ai-plug-controller';
    const token = '1'.repeat(64);
    let directory: string;
    let original: string | undefined;
    let controller: SkillDependenciesController;
    const request = (supplied: unknown = token) => ({ headers: { 'x-neurocenter-internal': supplied } } as unknown as Request);
    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-skill-internal-'));
        original = process.env.NEUROCENTER_INTERNAL_TOKEN; process.env.NEUROCENTER_INTERNAL_TOKEN = token;
        controller = new SkillDependenciesController(new FsSkillsStorage(directory));
    });
    afterEach(async () => {
        if (original === undefined) { delete process.env.NEUROCENTER_INTERNAL_TOKEN; } else { process.env.NEUROCENTER_INTERNAL_TOKEN = original; }
        await fs.rm(directory, { recursive: true, force: true });
    });
    it.each([undefined, '', 'wrong', '2'.repeat(64), [token, token]])('Отказывает без точного одиночного токена: %j', async supplied => {
        await expect(controller.usage(request(supplied === undefined ? null : supplied), assetId)).rejects.toMatchObject({ status: 403 });
    });
    it('Отказывает при отсутствии настройки внутреннего токена', async () => {
        delete process.env.NEUROCENTER_INTERNAL_TOKEN;
        await expect(controller.usage(request(), assetId)).rejects.toMatchObject({ status: 403 });
    });
    it.each(['', '../private', 'helper', ['ai-plug-controller']])('Проверяет точный ID инструмента: %j', async invalid => {
        await expect(controller.usage(request(), invalid as string)).rejects.toMatchObject({ status: 400 });
    });
    it('Возвращает только boolean без пути, pin и содержимого', async () => {
        const storage = new FsSkillsStorage(directory);
        await storage.writeSkill('common/private', normalizeMeta({ dependencies: [{ kind: 'mcp', id: assetId, version: 1, manifest: 'a'.repeat(64) }] }, 'private'), 'Приватная инструкция');
        expect(await controller.usage(request(), assetId)).toEqual({ inUse: true });
        expect(await controller.usage(request(), 'ai-plug-other')).toEqual({ inUse: false });
    });
    it('Ошибка полного сканирования остаётся 503 и не раскрывает путь', async () => {
        await fs.writeFile(path.join(directory, 'broken.md'), 'Не YAML');
        let error: unknown;
        try { await controller.usage(request(), assetId); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ status: 503 });
        expect((error as Error).message).not.toContain(directory);
    });
});
