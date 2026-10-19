import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessDb } from '../src/access/access-db';
import { CatalogController } from '../src/catalog/catalog.controller';
import type { CatalogService } from '../src/catalog/catalog.service';

const member = { userId: 'u-member@example.invalid', principalName: 'member@example.invalid', displayName: 'Участник', role: 'Наблюдатель', addedAt: '2026-10-18' };
const actor = 'admin@example.invalid';
const request = (activeRole = 'Главный админ') => ({ headers: {
    'x-bridge-principal': actor,
    'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: actor, activeRole })),
} });

describe('Исполнитель изменения проектных ролей', () => {
    const catalog = { listProjectMembers: vi.fn(), addProjectMember: vi.fn(), updateProjectMemberRole: vi.fn(), removeProjectMember: vi.fn() };
    const access = { save: vi.fn() };
    let controller: CatalogController;

    beforeEach(() => {
        vi.clearAllMocks();
        catalog.listProjectMembers.mockResolvedValue([member]);
        catalog.updateProjectMemberRole.mockResolvedValue({ ...member, role: 'Разработчик' });
        catalog.removeProjectMember.mockResolvedValue(true);
        controller = new CatalogController(catalog as unknown as CatalogService, access as unknown as AccessDb);
    });

    it('Выдача берёт автора из доверенного контекста, а не из тела', async () => {
        catalog.listProjectMembers.mockResolvedValue([]);
        const body = { principalName: member.principalName, role: 'Наблюдатель', actor: 'forged@example.invalid' };
        await controller.addProjectMember('prj-qa', body, request());
        expect(access.save).toHaveBeenCalledWith({ email: member.principalName, displayName: undefined }, actor);
        expect(catalog.addProjectMember).toHaveBeenCalledWith('prj-qa', expect.objectContaining({ principalName: member.principalName }), actor);
    });

    it('Смена и отзыв передают проверенную исходную роль вместе с исполнителем', async () => {
        await controller.updateProjectMember('prj-qa', member.userId, { role: 'Разработчик', expectedRole: 'Наблюдатель' }, request());
        expect(catalog.updateProjectMemberRole).toHaveBeenCalledWith('prj-qa', member.userId, 'Разработчик', 'Наблюдатель', actor);
        await controller.removeProjectMember('prj-qa', member.userId, request(), 'Наблюдатель');
        expect(catalog.removeProjectMember).toHaveBeenCalledWith('prj-qa', member.userId, 'Наблюдатель', actor);
    });

    it('Проверка прав происходит до сохранения и аудита даже для повторного запроса', async () => {
        await expect(controller.updateProjectMember('prj-qa', member.userId, { role: 'Наблюдатель' }, request('Наблюдатель'))).rejects.toMatchObject({ status: 403 });
        expect(catalog.updateProjectMemberRole).not.toHaveBeenCalled();
        expect(access.save).not.toHaveBeenCalled();
    });
});
