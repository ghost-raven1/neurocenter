import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogService } from '../src/catalog/catalog.service';
import { SkillAuditController } from '../src/publication/skill-audit.controller';

describe('Служебная доставка сводок аудита скиллов', () => {
    beforeEach(() => { vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'owned-token'); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('Проверяет служебный токен до передачи событий в каталог', async () => {
        const recordSkillAuditEvents = vi.fn();
        const controller = new SkillAuditController({ recordSkillAuditEvents } as unknown as CatalogService);
        await expect(controller.events('wrong-token', { events: [] })).rejects.toMatchObject({ status: 403 });
        expect(recordSkillAuditEvents).not.toHaveBeenCalled();
    });

    it('Возвращает точное подтверждение только после успешной записи', async () => {
        const recordSkillAuditEvents = vi.fn(async () => ({ accepted: 2 }));
        const controller = new SkillAuditController({ recordSkillAuditEvents } as unknown as CatalogService);
        const input = { events: [] };
        await expect(controller.events('owned-token', input)).resolves.toEqual({ accepted: 2 });
        expect(recordSkillAuditEvents).toHaveBeenCalledWith(input);
        recordSkillAuditEvents.mockRejectedValueOnce(new Error('Сбой PostgreSQL'));
        await expect(controller.events('owned-token', input)).rejects.toThrow('Сбой PostgreSQL');
    });
});
