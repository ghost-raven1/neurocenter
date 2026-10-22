import { describe, expect, it } from 'vitest';
import { allowRequest } from '../src/access/access-policy';
import type { IAccessClaims } from '../src/access/access.model';

const id = '12345678-1234-4234-8234-123456789abc';
const base = '/api/projects/prj-own/agents';
const claims: IAccessClaims = { email: 'trial-policy@example.test', userRoles: ['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель'],
    projects: [{ projectId: 'prj-own', projectName: 'Own', role: 'Админ проекта' }], pluginIds: [], skillPaths: [] };
const allowed = (role: string, method: string, suffix: string, value = claims) => allowRequest(value, role, { method, path: base + suffix });

describe('Agent trial admission uses working project access and exact methods', () => {
    const routes = [['GET', '/readiness'], ['HEAD', '/readiness'], ['POST', '/agent-one/readiness-trials'],
        ['GET', '/agent-one/readiness-trials/' + id], ['HEAD', '/agent-one/readiness-trials/' + id], ['POST', '/agent-one/readiness-trials/' + id + '/cancel']];
    it.each(routes)('admits %s %s for current developer and administrator roles', (method, route) => {
        for (const role of ['Главный админ', 'Админ проекта', 'Разработчик']) expect(allowed(role, method, route)).toBe(true);
        expect(allowed('Наблюдатель', method, route)).toBe(false);
    });
    it.each(routes)('denies %s %s without the current project grant or active role', (method, route) => {
        expect(allowed('Разработчик', method, route, { ...claims, projects: [] })).toBe(false);
        expect(allowed('Главный админ', method, route, { ...claims, userRoles: ['Разработчик'] })).toBe(false);
        expect(allowed('Админ проекта', method, route, { ...claims, projects: [{ ...claims.projects[0], role: 'Наблюдатель' }] })).toBe(false);
    });
    it.each(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'])('rejects unknown trial routes for %s even for main admin', method => {
        for (const suffix of ['/readiness/extra', '/agent-one/readiness-trials/' + id + '/retry', '/agent-one/readiness-trials/not-a-uuid',
            '/agent-one/readiness-trials/' + id + '/cancel/extra', '/invalid/readiness-trials', '/agent-one/readiness-trials/%ZZ']) {
            expect(allowed('Главный админ', method, suffix), method + suffix).toBe(false);
        }
    });
    it.each(['PATCH', 'PUT', 'DELETE', 'OPTIONS'])('does not accept %s in the trial namespace', method => {
        for (const [, suffix] of routes) expect(allowed('Главный админ', method, suffix)).toBe(false);
    });
    it('does not create a trial on reads or treat a detail as a mutation', () => {
        expect(allowed('Главный админ', 'GET', '/agent-one/readiness-trials')).toBe(false);
        expect(allowed('Главный админ', 'POST', '/readiness')).toBe(false);
        expect(allowed('Главный админ', 'POST', '/agent-one/readiness-trials/' + id)).toBe(false);
        expect(allowed('Главный админ', 'GET', '/agent-one/readiness-trials/' + id + '/cancel')).toBe(false);
    });
    it('canonicalizes one encoded route and rejects encoded slashes that change its structure', () => {
        expect(allowed('Разработчик', 'POST', '/%61gent-one/readiness-trials/')).toBe(true);
        expect(allowed('Главный админ', 'POST', '/agent-one%2fother/readiness-trials')).toBe(false);
        expect(allowed('Главный админ', 'POST', '/agent-one/readiness-trials/%2e%2e')).toBe(false);
    });
});
