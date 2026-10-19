import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installLocalAsset, resolveFsRootPath, scanLocalAssets } from '../src/catalog/local-assets';

describe('Установка в настроенный каталог проектов', () => {
    let root: string;
    beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(),'neurocenter-install-')); vi.stubEnv('PROJECTS_ROOT',root); });
    afterEach(async () => { vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true}); });

    it('Установка и сканирование используют один PROJECTS_ROOT', async () => {
        const content='---\nname: helper\n---\n\nИнструкция';
        await installLocalAsset({kind:'skill',name:'helper',projectName:'demo',content});

        expect(await readFile(path.join(root,'demo/.opencode/skills/helper/SKILL.md'),'utf8')).toBe(content);
        expect((await scanLocalAssets()).projects).toEqual(expect.arrayContaining([expect.objectContaining({project:'demo',skills:['helper']})]));
    });

    it('Путь вне корня проектов отклоняется', () => {
        expect(() => resolveFsRootPath(path.join(root,'../outside'))).toThrow();
        expect(resolveFsRootPath(path.join(root,'demo'))).toBe(path.join(root,'demo'));
    });

    it('Относительный путь к разрешённой папке не зависит от рабочего каталога сервиса', () => {
        const relative=path.relative(process.cwd(),path.join(root,'demo'));
        expect(() => resolveFsRootPath(relative)).toThrow('абсолютным');
        expect(() => resolveFsRootPath('')).toThrow('абсолютным');
        vi.stubEnv('PROJECTS_ROOT',process.cwd());
        expect(() => resolveFsRootPath('demo')).toThrow('абсолютным');
    });

    it('Соседняя папка с тем же префиксом не становится частью корня проектов', () => {
        expect(() => resolveFsRootPath(root+'-other/demo')).toThrow();
        expect(resolveFsRootPath(path.join(root,'demo','..','ready'))).toBe(path.join(root,'ready'));
    });
});
