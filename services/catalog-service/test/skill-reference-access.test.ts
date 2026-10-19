import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AccessController } from '../src/access/access.controller';
import type { AccessDb } from '../src/access/access-db';
import type { IAccessClaims } from '../src/access/access.model';
import { fetchSkillReferences, resolveSkillReadClaims, resolveSkillReference } from '../src/access/skill-reference';
import { CatalogService } from '../src/catalog/catalog.service';
import { assertDeviceCatalogAsset } from '../src/devices/device-catalog-access';
import { filterResponse } from '../../api-gateway/src/proxy/access-response';

const summary = (path: string, slug = path.split('/').at(-1)!) => ({ path, meta: { slug } });
const index = [summary('ops/rag-index-monitor'), summary('project-prj-other/rag-index-monitor'), summary('common/other')];
const claims = (role = 'Разработчик'): IAccessClaims => ({ email: 'reader@example.test', userRoles: [role],
    projects: [{ projectId: 'prj-own', projectName: 'Свой проект', role }], pluginIds: [], skillPaths: ['rag-index-monitor'] });

describe('Старые короткие ссылки проектного каталога скиллов', () => {
    beforeEach(() => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'test-internal-token');
        vi.stubEnv('SKILLS_SERVICE_URL', 'http://skills.internal:4200');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, json: async () => index }));
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it.each(['Разработчик', 'Наблюдатель'])('Роль %s видит общий скилл из старого назначения в списке, дереве и карточке', async role => {
        const controller = new AccessController({ claims: vi.fn().mockResolvedValue(claims(role)) } as unknown as AccessDb);
        const list = await controller.authorize('test-internal-token', { email: 'reader@example.test', activeRole: role, method: 'GET', path: '/api/skills' });
        expect(list.allowed).toBe(true);
        expect(list.claims.skillPaths).toEqual(['ops/rag-index-monitor']);
        expect(filterResponse(index, list.claims, role, '/api/skills')).toEqual([index[0]]);
        expect(filterResponse([{ name: 'ops', children: [index[0]] }, { name: 'private', children: [index[1]] }], list.claims, role, '/api/skills/tree'))
            .toEqual([{ name: 'ops', children: [index[0]] }]);
        for (const path of ['/api/skills/ops/rag-index-monitor', '/api/skills/_package/ops/rag-index-monitor']) {
            expect((await controller.authorize('test-internal-token', { email: 'reader@example.test', activeRole: role, method: 'HEAD', path })).allowed).toBe(true);
        }
        expect((await controller.authorize('test-internal-token', { email: 'reader@example.test', activeRole: role, method: 'GET', path: '/api/skills/project-prj-other/rag-index-monitor' })).allowed).toBe(false);
    });

    it('Мост признаёт старое назначение только в выбранном проекте', async () => {
        const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rows: [{ asset_id: 'rag-index-monitor' }] });
        await expect(assertDeviceCatalogAsset({ query } as unknown as Pool, 'prj-own', 'skill', 'ops/rag-index-monitor')).resolves.toBeUndefined();
        expect(query.mock.calls[1][1]).toEqual(['prj-own']);
        expect(query.mock.calls[1][0]).toContain("asset_kind='skill'");
        expect(fetch).toHaveBeenCalledWith(new URL('http://skills.internal:4200/api/skills'), expect.objectContaining({ headers: { 'x-neurocenter-internal': 'test-internal-token' }, redirect: 'error' }));
    });

    it('Точное корневое имя сохраняет приоритет над одноимённым вложенным скиллом', () => {
        const rootIndex = [...index, summary('rag-index-monitor')];
        expect(resolveSkillReference('rag-index-monitor', rootIndex)).toBe('rag-index-monitor');
        expect(resolveSkillReference('ops/rag-index-monitor', rootIndex)).toBe('ops/rag-index-monitor');
        expect(resolveSkillReference('missing/rag-index-monitor', rootIndex)).toBeUndefined();
    });

    it('Два общих совпадения неоднозначны, совпадение в чужом проекте не расширяет права', async () => {
        const ambiguous = [...index, summary('common/rag-index-monitor')];
        vi.mocked(fetch).mockResolvedValue({ status: 200, json: async () => ambiguous } as Response);
        const resolved = await resolveSkillReadClaims(claims(), 'Разработчик', { method: 'GET', path: '/api/skills' });
        expect(resolved.skillPaths).toEqual([]);
        expect(filterResponse(ambiguous, resolved, 'Разработчик', '/api/skills')).toEqual([]);
        const query = vi.fn().mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [{ asset_id: 'rag-index-monitor' }] });
        await expect(assertDeviceCatalogAsset({ query } as unknown as Pool, 'prj-own', 'skill', 'ops/rag-index-monitor')).rejects.toMatchObject({ status: 403 });
        expect(resolveSkillReference('rag-index-monitor', [index[1]])).toBeUndefined();
    });

    it('Ссылка не выдаёт чужой проект и не раскрывает другой проектный каталог через мост', async () => {
        const query = vi.fn();
        await expect(assertDeviceCatalogAsset({ query } as unknown as Pool, 'prj-own', 'skill', index[1].path)).rejects.toMatchObject({ status: 403 });
        expect(query).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('Не связанные со скиллами запросы, изменения, полные пути и административное чтение не требуют файлового сервиса', async () => {
        for (const [role, request, paths] of [
            ['Разработчик', { method: 'GET', path: '/api/projects' }, ['rag-index-monitor']],
            ['Разработчик', { method: 'POST', path: '/api/skills' }, ['rag-index-monitor']],
            ['Разработчик', { method: 'GET', path: '/api/skills' }, ['ops/rag-index-monitor']],
            ['Админ проекта', { method: 'GET', path: '/api/skills' }, ['rag-index-monitor']],
            ['Главный админ', { method: 'GET', path: '/api/skills' }, ['rag-index-monitor']],
        ] as const) {
            const original = { ...claims(role), skillPaths: [...paths] };
            expect(await resolveSkillReadClaims(original, role, request)).toBe(original);
        }
        expect(await resolveSkillReadClaims(claims('Наблюдатель'), 'Разработчик', { method: 'GET', path: '/api/skills' })).toEqual(claims('Наблюдатель'));
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([null, {}, [{ path: '../escape', meta: { slug: 'escape' } }], [{ path: 'ops/ok', meta: null }]])('Повреждённый индекс %j останавливает проверку доступа', async payload => {
        vi.mocked(fetch).mockResolvedValue({ status: 200, json: async () => payload } as Response);
        await expect(fetchSkillReferences()).rejects.toMatchObject({ status: 503 });
    });

    it('Отказ сервиса не разрешает старую ссылку и не скрывает ошибку за пустым каталогом', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('network down'));
        await expect(resolveSkillReadClaims(claims(), 'Разработчик', { method: 'GET', path: '/api/skills' })).rejects.toMatchObject({ status: 503 });
        const query = vi.fn().mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [{ asset_id: 'rag-index-monitor' }] });
        await expect(assertDeviceCatalogAsset({ query } as unknown as Pool, 'prj-own', 'skill', 'ops/rag-index-monitor')).rejects.toMatchObject({ status: 503 });
    });

    it('Новое назначение записывает полный существующий путь и не изменяет старые назначения', async () => {
        const db = { addProjectAsset: vi.fn().mockResolvedValue(undefined) };
        const service = Object.assign(Object.create(CatalogService.prototype), { db }) as CatalogService;
        await service.addProjectAsset('prj-own', 'rag-index-monitor', 'skill', 'admin@example.test');
        expect(db.addProjectAsset).toHaveBeenCalledWith('prj-own', 'ops/rag-index-monitor', 'skill', 'admin@example.test');
    });

    it.each(['missing', 'missing/rag-index-monitor', '../escape', 'project-prj-other/rag-index-monitor'])('Новое несуществующее или чужое назначение %s не записывается', async path => {
        const db = { addProjectAsset: vi.fn() };
        const service = Object.assign(Object.create(CatalogService.prototype), { db }) as CatalogService;
        await expect(service.addProjectAsset('prj-own', path, 'skill', 'admin@example.test')).rejects.toThrow();
        expect(db.addProjectAsset).not.toHaveBeenCalled();
    });

    it('Новый неоднозначный slug и недоступный сервис не оставляют назначения', async () => {
        const db = { addProjectAsset: vi.fn() };
        const service = Object.assign(Object.create(CatalogService.prototype), { db }) as CatalogService;
        vi.mocked(fetch).mockResolvedValueOnce({ status: 200, json: async () => [...index, summary('common/rag-index-monitor')] } as Response);
        await expect(service.addProjectAsset('prj-own', 'rag-index-monitor', 'skill', 'admin@example.test')).rejects.toMatchObject({ status: 400 });
        vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
        await expect(service.addProjectAsset('prj-own', 'ops/rag-index-monitor', 'skill', 'admin@example.test')).rejects.toMatchObject({ status: 503 });
        expect(db.addProjectAsset).not.toHaveBeenCalled();
    });
});
