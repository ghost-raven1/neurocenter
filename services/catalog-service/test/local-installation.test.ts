import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveFsRootPath, scanLocalAssets } from '../src/catalog/local-assets';

describe('Сканирование и пути настроенного каталога серверных проектов', () => {
    let root: string;
    beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(),'neurocenter-install-')); vi.stubEnv('PROJECTS_ROOT',root); });
    afterEach(async () => { vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true}); });

    it('Сканирование серверных проектов использует PROJECTS_ROOT без установки ассетов', async () => {
        await mkdir(path.join(root,'demo'));
        expect((await scanLocalAssets()).projects).toEqual(expect.arrayContaining([expect.objectContaining({project:'demo',path:path.join(root,'demo')})]));
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
