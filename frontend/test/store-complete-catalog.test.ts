import { describe, expect, it, vi } from 'vitest';
import type { IAiPlugin, IPage } from '../src/core/api/interfaces';
import { loadCompletePluginCatalog } from '../src/modules/Store/loadCompletePluginCatalog';
import { unavailableProjectAssets } from '../src/modules/Store/selectUnavailableProjectAssets';
import { fromPlugin } from '../src/modules/Store/storeHelpers';

const plugin = (index: number): IAiPlugin => ({ id: `ai-plug-${index}`, name: `Инструмент ${index}`, kind: 'mcp',
    description: '', version: 1, tags: [], origin: 'fixture', files: [], createdAt: '', updatedAt: '' });
const page = (items: IAiPlugin[], number = 1, total = items.length, size = 100): IPage<IAiPlugin> => ({ items, page: number, total, size });
const current = (): boolean => true;

describe('Каталог полностью загружается до проверки отсутствующих инструментов', () => {
    it('Назначенный инструмент после первых ста карточек остаётся доступным', async () => {
        const plugins = Array.from({ length: 205 }, (_, index) => plugin(index));
        const read = vi.fn().mockResolvedValueOnce(page(plugins.slice(0, 100), 1, 205))
            .mockResolvedValueOnce(page(plugins.slice(100, 200), 2, 205)).mockResolvedValueOnce(page(plugins.slice(200), 3, 205));
        const result = await loadCompletePluginCatalog(read, current);
        expect(result).toEqual(plugins);
        expect(read.mock.calls).toEqual([[{ pageSize: 100, page: 1 }], [{ pageSize: 100, page: 2 }], [{ pageSize: 100, page: 3 }]]);
        expect(unavailableProjectAssets([{ assetKind: 'mcp', assetId: plugins[204].id, addedBy: 'qa@example.test', addedAt: '' }],
            result!.map(fromPlugin), 'prj-example')).toEqual([]);
    });

    it('Учитывает фактический размер страницы сервера', async () => {
        const read = vi.fn().mockResolvedValueOnce(page([plugin(1)], 1, 2, 1)).mockResolvedValueOnce(page([plugin(2)], 2, 2, 1));
        await expect(loadCompletePluginCatalog(read, current)).resolves.toEqual([plugin(1), plugin(2)]);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('Настоящий пустой каталог не требует второй страницы', async () => {
        const read = vi.fn().mockResolvedValue(page([]));
        await expect(loadCompletePluginCatalog(read, current)).resolves.toEqual([]);
        expect(read).toHaveBeenCalledOnce();
    });

    it('Сбой следующей страницы не возвращает частичный каталог', async () => {
        const read = vi.fn().mockResolvedValueOnce(page([plugin(1)], 1, 2, 1)).mockRejectedValueOnce(new Error('Связь потеряна'));
        await expect(loadCompletePluginCatalog(read, current)).rejects.toThrow('Связь потеряна');
    });

    it.each([
        ['пустая следующая страница', page([], 2, 2, 1)],
        ['повтор предыдущей страницы', page([plugin(1)], 1, 2, 1)],
        ['дубликат карточки', page([plugin(1)], 2, 2, 1)],
        ['изменение общего количества', page([plugin(2)], 2, 3, 1)],
        ['изменение размера страницы', page([plugin(2)], 2, 2, 2)],
    ])('Ошибка целостности не скрывается: %s', async (_name, nextPage) => {
        const read = vi.fn().mockResolvedValueOnce(page([plugin(1)], 1, 2, 1)).mockResolvedValueOnce(nextPage);
        await expect(loadCompletePluginCatalog(read, current)).rejects.toThrow('загружен не полностью');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it.each([
        page([plugin(1)], 0), page([plugin(1)], 1, -1), page([plugin(1)], 1, 1, 0), page([plugin(1)], 1, 1, 101),
        page([plugin(1)], 1, 2), page([plugin(1), plugin(1)], 1, 2),
    ])('Отклоняет противоречивый первый ответ %j', async invalid => {
        const read = vi.fn().mockResolvedValue(invalid);
        await expect(loadCompletePluginCatalog(read, current)).rejects.toThrow('загружен не полностью');
        expect(read).toHaveBeenCalledOnce();
    });

    it('Не начинает чтение от имени прежнего владельца', async () => {
        const read = vi.fn();
        await expect(loadCompletePluginCatalog(read, () => false)).resolves.toBeNull();
        expect(read).not.toHaveBeenCalled();
    });

    it('Смена владельца во время запроса останавливает остальные страницы', async () => {
        let active = true;
        let finish!: (value: IPage<IAiPlugin>) => void;
        const read = vi.fn().mockReturnValue(new Promise<IPage<IAiPlugin>>(resolve => { finish = resolve; }));
        const pending = loadCompletePluginCatalog(read, () => active);
        active = false;
        finish(page([plugin(1)], 1, 2, 1));
        await expect(pending).resolves.toBeNull();
        expect(read).toHaveBeenCalledOnce();
    });
});
