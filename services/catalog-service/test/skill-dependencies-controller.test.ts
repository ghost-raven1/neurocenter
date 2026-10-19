import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogService } from '../src/catalog/catalog.service';
import { SkillDependenciesController } from '../src/publication/skill-dependencies.controller';

describe('Служебное закрепление зависимостей скилла', () => {
    beforeEach(() => { vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'owned-token'); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('Проверяет токен до обращения к реестру', async () => {
        const reserveSkillDependencies = vi.fn();
        const controller = new SkillDependenciesController({ reserveSkillDependencies } as unknown as CatalogService);
        await expect(controller.reserve('wrong-token', { entries: [] })).rejects.toMatchObject({ status: 403 });
        expect(reserveSkillDependencies).not.toHaveBeenCalled();
    });

    it('Передаёт неизменённый пакет и возвращает подтверждение резервирования', async () => {
        const reserveSkillDependencies = vi.fn(async () => ({ reserved: 1 }));
        const controller = new SkillDependenciesController({ reserveSkillDependencies } as unknown as CatalogService);
        const input = { entries: [{ key: 'a'.repeat(64), path: 'shared/test', dependencies: [] }] };
        await expect(controller.reserve('owned-token', input)).resolves.toEqual({ ok: true, reserved: 1 });
        expect(reserveSkillDependencies).toHaveBeenCalledWith(input);
    });
});
