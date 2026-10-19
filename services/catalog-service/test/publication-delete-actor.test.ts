import { describe, expect, it, vi } from 'vitest';

import type { AccessDb } from '../src/access/access-db';
import { CatalogController } from '../src/catalog/catalog.controller';
import type { CatalogService } from '../src/catalog/catalog.service';

describe('Исполнитель удаления инструмента', () => {
    const actor = 'operator@example.test';
    const request = (activeRole: string) => ({ headers: {
        'x-bridge-principal': actor,
        'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: actor, activeRole })),
    } });

    it('Передаёт главного администратора из доверенного контекста', async () => {
        const remove = vi.fn().mockResolvedValue({ ok: true, id: 'ai-plug-qa' });
        const controller = new CatalogController({ deleteAiPlugin: remove } as unknown as CatalogService, {} as AccessDb);
        await controller.deleteAiPlugin('ai-plug-qa', request('Главный админ'));
        expect(remove).toHaveBeenCalledWith('ai-plug-qa', actor);
    });

    it('Запрещает удаление другой роли до изменения данных и аудита', () => {
        const remove = vi.fn();
        const controller = new CatalogController({ deleteAiPlugin: remove } as unknown as CatalogService, {} as AccessDb);
        expect(() => controller.deleteAiPlugin('ai-plug-qa', request('Админ проекта'))).toThrow();
        expect(remove).not.toHaveBeenCalled();
    });
});
