import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceArtifacts } from '../src/devices/device-artifacts';
import type { CatalogService } from '../src/catalog/catalog.service';
import { verifyPackage } from '../src/catalog/bundle-package';
import { assertPackageBridge } from '../src/devices/device-compatibility';

describe('Пакет скилла для локальной установки', () => {
    const fetchMock = vi.fn();
    const service = new DeviceArtifacts({} as CatalogService);
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockResolvedValue(
            Response.json({
                meta: {
                    slug: 'test',
                    version: 3,
                    description: 'Помощник',
                    mcp: ['example'],
                },
                body: 'Инструкция',
            }),
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    it('Сохраняет точную версию и зависимости в пакете', async () => {
        const pkg = await service.build('skill', 'ops/test', 3);
        expect(pkg.plugin.version).toBe(3);
        expect(pkg.config?.extra?.requirements).toEqual({
            mcp: ['example'],
            plugins: [],
        });
        expect(pkg.files[0].content).toContain('Инструкция');
        expect(fetchMock.mock.calls[0][0]).toContain('/api/skills/_package/ops/test');
        expect(fetchMock.mock.calls[0][0]).toContain('?version=3');
    });
    it('Изменившаяся версия требует перечитать карточку', async () => {
        await expect(service.build('skill', 'ops/test', 2)).rejects.toThrow(
            'Скилл изменился',
        );
    });
    it('Включает точные зависимости в подписанный манифест без выбора head',async()=>{
        const dependency={kind:'mcp',id:'ai-plug-example',version:2,manifest:'a'.repeat(64)};
        fetchMock.mockResolvedValueOnce(Response.json({meta:{slug:'test',version:1,dependencies:[dependency]},body:'Инструкция'}));
        const pkg=await service.build('skill','ops/test',1);
        expect(pkg.config?.extra?.requirements).toEqual({mcp:[],plugins:[],dependencies:[dependency]});
        expect(verifyPackage(pkg)).toBe(true);
        expect(verifyPackage({...pkg,config:{...pkg.config,extra:{requirements:{mcp:[],plugins:[],dependencies:[]}}}})).toBe(false);
    });
    it('Повреждённый pin upstream не исчезает молча из установочного пакета',async()=>{
        fetchMock.mockResolvedValueOnce(Response.json({meta:{slug:'test',version:1,dependencies:[{kind:'mcp',id:'latest'}]},body:'Инструкция'}));
        await expect(service.build('skill','ops/test',1)).rejects.toMatchObject({status:502});
    });
    it('Ошибка сервиса не превращается в пакет с пустым содержимым', async () => {
        fetchMock.mockResolvedValue(
            Response.json({ message: 'not found' }, { status: 404 }),
        );
        await expect(service.build('skill', 'ops/test', 3)).rejects.toThrow(
            'Не удалось прочитать',
        );
    });
    it('Ресурсы входят в манифест; бинарный файл требует обновлённого моста', async () => {
        fetchMock.mockResolvedValue(Response.json({meta:{slug:'test',version:1},body:'Инструкция',resources:[
            {path:'references/guide.md',content:'Справочник'},
            {path:'assets/example.bin',content:'AP+A',encoding:'base64'},
        ]}));
        const pkg = await service.build('skill','ops/test',1);
        expect(pkg.schemaVersion).toBe(4); expect(pkg.files).toHaveLength(3);
        expect(pkg.files[2].size).toBe(3); expect(verifyPackage(pkg)).toBe(true);
        expect(()=>assertPackageBridge({capabilities:['managed-installations']},pkg)).toThrow('Обновите');
        expect(()=>assertPackageBridge({capabilities:['package-v4']},pkg)).not.toThrow();
        const changed = {...pkg,files:pkg.files.map(file=>file.encoding?{...file,content:'AAAA'}:file)};
        expect(verifyPackage(changed)).toBe(false);
    });
    it('Новые текстовые пакеты также требуют детерминированный формат 4', async () => {
        fetchMock.mockResolvedValue(Response.json({meta:{slug:'test',version:1},body:'Инструкция',resources:[{path:'scripts/check.js',content:'console.log(1)'}]}));
        const pkg = await service.build('skill','ops/test',1);
        expect(pkg.schemaVersion).toBe(4); expect(verifyPackage(pkg)).toBe(true);
        expect(()=>assertPackageBridge({},pkg)).toThrow('Обновите');
        expect(()=>assertPackageBridge({capabilities:['package-v4']},pkg)).not.toThrow();
    });
    it('Сетевая ошибка upstream даёт понятный 502 без выдачи пустого пакета', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('private-service.internal:4200'));
        await expect(service.build('skill','ops/test',1)).rejects.toMatchObject({status:502,message:expect.stringContaining('недоступен')});
    });
    it.each([null, {}, {meta:{version:1},body:'Инструкция',resources:'broken'}])('Повреждённый ответ upstream не превращается в ошибку приложения: %j',async body=>{
        fetchMock.mockResolvedValueOnce(Response.json(body));
        await expect(service.build('skill','ops/test',1)).rejects.toMatchObject({status:502});
    });
});
