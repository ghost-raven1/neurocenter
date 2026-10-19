import { beforeEach, describe, expect, it, vi } from 'vitest';

import bffApi from '../src/core/api/bff';
import { installApp } from '../src/modules/Store/storeInstall';
import type { IStoreApp } from '../src/modules/Store/AppCard';

vi.mock('../src/core/api/bff', () => ({ default: { getSkill: vi.fn(), installLocalAsset: vi.fn() } }));

describe('Установка инструментов в один клик', () => {
    const app: IStoreApp = { id: 'common/helper', name: 'helper', path: 'common/helper', kind: 'skill', description: '', version: 1, tags: [], origin: '' };
    beforeEach(() => { vi.resetAllMocks(); vi.mocked(bffApi.installLocalAsset).mockResolvedValue({} as never); });

    it('Передаёт в SKILL.md метаданные и исходное содержимое', async () => {
        vi.mocked(bffApi.getSkill).mockResolvedValue({ path: app.path, meta: { name: 'helper', slug: 'helper', description: 'Помощник команды', tags: ['код'], mcp: ['browser'], version: 2 }, body: '# Инструкция\nПроверь код.' } as never);
        const result = await installApp(app, 'demo');
        const payload = vi.mocked(bffApi.installLocalAsset).mock.calls[0][0];

        expect(result.ok).toBe(true);
        expect(payload.content).toContain('name: "helper"');
        expect(payload.content).toContain('description: "Помощник команды"');
        expect(payload.content).toContain('mcp: ["browser"]');
        expect(payload.content).toContain('# Инструкция\nПроверь код.');
    });

    it('Передаёт файлы MCP-бандла вместе с конфигурацией запуска', async () => {
        await installApp({ ...app, id:'mcp',kind:'mcp',config:{command:'node',args:['index.js']},files:[{path:'index.js',content:'console.log("ready")'}] }, 'demo');

        expect(bffApi.installLocalAsset).toHaveBeenCalledWith(expect.objectContaining({
            files: [{path:'index.js',content:'console.log("ready")'}], config:{command:'node',args:['index.js']},
        }));
    });

    it('Показывает отказ сервера и не сообщает об успешной установке', async () => {
        vi.mocked(bffApi.installLocalAsset).mockRejectedValue({ response: { data: { message: 'Нет доступа к проекту' } } });
        const result = await installApp({ ...app, kind:'mcp' }, 'demo');

        expect(result).toEqual({ok:false,message:'Нет доступа к проекту'});
    });
});
