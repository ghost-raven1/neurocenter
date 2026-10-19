import { describe, expect, it, vi } from 'vitest';

import type { IProjectAsset } from '../src/core/api/interfaces';
import { createProjectCatalogController, type IProjectCatalogState } from '../src/modules/Store/projectCatalogController';

const assets: IProjectAsset[] = [{ assetId: 'qa-mcp', assetKind: 'mcp', addedBy: 'qa@example.invalid', addedAt: '2026-10-18T00:00:00Z' }];
const failure = (status: number) => ({ isAxiosError: true, response: { status } });
function setup() {
    let scope = 'user/project-a';
    const read = vi.fn<() => Promise<IProjectAsset[]>>().mockResolvedValue(assets);
    const states: IProjectCatalogState[] = [];
    const controller = createProjectCatalogController({ getScope: () => scope, read, onChange: state => states.push(state) });
    controller.activate();
    return { controller, read, states, changeScope: () => { scope = 'user/project-b'; }, latest: () => states.at(-1)! };
}

describe('Каталог принадлежит текущему проекту и правам', () => {
    it('Поздний ответ A и его callback повтора не читают и не изменяют B', async () => {
        const test = setup();
        let complete!: (value: IProjectAsset[]) => void;
        test.read.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        const pending = test.controller.refresh();
        test.changeScope();
        test.controller.dispose();
        const count = test.states.length;
        complete(assets);
        await pending;
        await test.controller.refresh();
        expect(test.states).toHaveLength(count);
        expect(test.read).toHaveBeenCalledTimes(1);
    });

    it('Запоздалая ошибка не перекрывает новый успешный запрос', async () => {
        const test = setup();
        let reject!: (reason: unknown) => void;
        test.read.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
        const old = test.controller.refresh();
        await test.controller.refresh();
        reject(failure(503));
        await old;
        expect(test.latest()).toEqual({ assets, ready: true, loading: false, error: '' });
    });

    it('Сбой обновления сохраняет прежние данные с постоянной ошибкой и допускает повтор', async () => {
        const test = setup();
        await test.controller.refresh();
        test.read.mockRejectedValueOnce(failure(503));
        await test.controller.refresh();
        expect(test.latest()).toMatchObject({ assets, ready: true, loading: false });
        expect(test.latest().error).toContain('Повторите загрузку');
        await test.controller.refresh();
        expect(test.latest().error).toBe('');
    });

    it.each([401, 403, 404])('Отказ %i убирает прежние разрешения до успешного чтения', async status => {
        const test = setup();
        await test.controller.refresh();
        test.read.mockRejectedValueOnce(failure(status));
        await test.controller.refresh();
        expect(test.latest()).toMatchObject({ assets: [], ready: false, loading: false });
        expect(test.latest().error).not.toBe('');
        await test.controller.refresh();
        expect(test.latest()).toEqual({ assets, ready: true, loading: false, error: '' });
    });

    it('Ошибка первого чтения не выдаёт неизвестный каталог за готовый пустой', async () => {
        const test = setup();
        test.read.mockRejectedValueOnce(failure(503));
        await test.controller.refresh();
        expect(test.latest()).toMatchObject({ assets: [], ready: false, loading: false });
        expect(test.latest().error).not.toBe('');
    });

    it('Повторная активация не принимает результат прежнего владельца', async () => {
        const test = setup();
        let complete!: (value: IProjectAsset[]) => void;
        test.read.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        const old = test.controller.refresh();
        test.controller.dispose(); test.controller.activate();
        test.read.mockResolvedValueOnce([]);
        await test.controller.refresh();
        complete(assets); await old;
        expect(test.latest()).toEqual({ assets: [], ready: true, loading: false, error: '' });
    });
});
