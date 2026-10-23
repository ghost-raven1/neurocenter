import { describe, expect, it } from 'vitest';
import { allowRequest } from '../src/access/access-policy';
import type { IAccessClaims } from '../src/access/access.model';
const base = '/api/projects/prj-shared/team-chat', id = '12345678-1234-4234-8234-123456789abc';
const claims: IAccessClaims = { email: 'team@example.test', userRoles: ['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель'],
    projects: [{ projectId: 'prj-shared', projectName: 'Shared', role: 'Админ проекта' }], pluginIds: [], skillPaths: [] };
describe('Shared project chat admission routes', () => {
    it.each(['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель'])('retains authorized history reads for %s', role => {
        for (const path of [base, base + '/history']) for (const method of ['GET', 'HEAD']) expect(allowRequest(claims, role, { method, path })).toBe(true);
    });
    it('allows developers to post, retry and cancel but only admins to configure', () => {
        for (const path of [base + '/messages', base + '/messages/' + id + '/retry', base + '/messages/' + id + '/cancel']) {
            expect(allowRequest(claims, 'Разработчик', { method: 'POST', path })).toBe(true);
            expect(allowRequest(claims, 'Наблюдатель', { method: 'POST', path })).toBe(false);
        }
        expect(allowRequest(claims, 'Разработчик', { method: 'PUT', path: base + '/participants' })).toBe(false);
        expect(allowRequest(claims, 'Админ проекта', { method: 'PUT', path: base + '/participants' })).toBe(true);
    });
    it('denies other projects, malformed or undeclared suffixes and unsupported verbs', () => {
        for (const path of [base.replace('prj-shared', 'prj-foreign'), base + '/keys', base + '-other', base + '/messages/' + id + '/unknown'])
            expect(allowRequest(claims, 'Разработчик', { method: 'GET', path })).toBe(false);
        expect(allowRequest(claims, 'Главный админ', { method: 'DELETE', path: base })).toBe(false);
    });
});
