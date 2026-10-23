import { describe, expect, it } from 'vitest';
import { roleSelection, roleResult, startRoleRun } from '../src/system-roles/system-role.validation';
import { roleProjection, restoreRoleProjection } from '../src/system-roles/system-role.privacy';
import { roleDefinitionPin, roleHash } from '../src/system-roles/system-role.definitions';
import { allowSystemRoleRoute } from '../src/system-roles/system-role.access';
import type { RolePrepared } from '../src/system-roles/system-role.types';

const selection = { projectId: null, instruction: 'Проверь готовность', diagnostics: ['health'], targets: [] };
describe('Bounded system role contracts', () => {
    it('pins canonical definitions and selected JSON without depending on JSONB key order', () => {
        expect(roleHash({ a: false, b: { x: null, y: 1 } })).toBe(roleHash({ b: { y: 1, x: null }, a: false }));
        expect(roleDefinitionPin('agent-ai-admin')).not.toBe(roleDefinitionPin('agent-autoconfigurator'));
    });
    it.each([{ ...selection, command: 'docker exec' }, { ...selection, diagnostics: ['arbitrary-url'] }, { ...selection, diagnostics: Array(5).fill('health') },
        { ...selection, projectId: '../other' }, { ...selection, targets: [{ kind: 'adapter', id: 'model-one', text: 'API key' }] }])('rejects unselected tool/source fields: %j', input => {
        expect(() => roleSelection('agent-ai-admin', input)).toThrow();
    });
    it('requires an exact consent/model/definition pin for explicit start', () => {
        const input = { ...selection, requestId: '12345678-1234-1234-1234-123456789abc', modelId: 'model-one', expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: roleDefinitionPin('agent-ai-admin'), consentDigest: 'b'.repeat(64) };
        expect(startRoleRun('agent-ai-admin', input)).toEqual(input);
        expect(() => startRoleRun('agent-ai-admin', { ...input, expectedModelPin: 'latest' })).toThrow();
    });
    it('keeps arbitrary nested parameter strings private and preserves false/null without loss', () => {
        const options = { apiFormat: 'responses', store: false, providerParameters: { arbitrary: { falseValue: false, nullValue: null, privateValue: 'sensitive note', credential: 'owner-secret' } } };
        const preview = roleProjection(options, true, ['apiFormat']);
        expect(preview.content).not.toContain('owner-secret'); expect(preview.content).not.toContain('sensitive note');
        expect(JSON.parse(restoreRoleProjection(preview.content, preview, true))).toEqual(options);
        const proposed = JSON.parse(preview.content); proposed.store = true;
        expect(JSON.parse(restoreRoleProjection(JSON.stringify(proposed), preview, true))).toEqual({ ...options, store: true });
    });
    it('rejects moving, removing, duplicating or inventing hidden private values', () => {
        const projection = roleProjection({ providerParameters: { hidden: 'secret' } }, true);
        for (const content of ['{}', '{"other":"[NC_PRIVATE_1]"}', '{"providerParameters":{"hidden":"[NC_PRIVATE_1]"},"other":"[NC_PRIVATE_1]"}', '{"providerParameters":{"hidden":"[NC_PRIVATE_2]"}}']) expect(() => restoreRoleProjection(content, projection, true)).toThrow('приват');
    });
    it('does not transmit explicit text credentials and rejects reserved marker injection', () => {
        const projection = roleProjection('Useful prompt\nAPI_KEY=do-not-send\nAuthorization: Bearer abcdefghijkl');
        expect(projection.content).not.toContain('do-not-send'); expect(projection.content).not.toContain('abcdefghijkl');
        expect(restoreRoleProjection(projection.content, projection)).toContain('API_KEY=do-not-send');
        expect(() => roleProjection('inject [NC_PRIVATE_1]')).toThrow();
    });
    it('limits model output to selected targets and measured evidence identities', () => {
        const prepared = { targets: [{ key: 'prompt:selected' }] } as RolePrepared;
        const value = { kind: 'proposal', summary: 'Уточнить запрос', findings: [], nextSteps: [], changes: [{ targetKey: 'prompt:selected', replacement: 'Уточнённый текст', explanation: 'Понятный результат' }] };
        expect(roleResult(JSON.stringify(value), prepared, [])).toEqual(value);
        expect(() => roleResult(JSON.stringify({ ...value, changes: [{ ...value.changes[0], targetKey: 'agent:unselected' }] }), prepared, [])).toThrow();
        expect(() => roleResult(JSON.stringify({ ...value, findings: [{ evidenceId: 'invented', detail: 'All green' }] }), prepared, [])).toThrow();
        expect(() => roleResult(JSON.stringify({ ...value, command: 'shell' }), prepared, [])).toThrow();
    });
    it('admits only known routes and keeps history/cancel/rollback independent of create authority', () => {
        const root = '/api/system-roles/agent-ai-admin', run = root + '/runs/12345678-1234-1234-1234-123456789abc';
        expect(allowSystemRoleRoute('Наблюдатель', 'GET', run)).toBe(true);
        expect(allowSystemRoleRoute('Наблюдатель', 'POST', run + '/cancel')).toBe(true);
        expect(allowSystemRoleRoute('Админ проекта', 'POST', root + '/prepare')).toBe(true);
        expect(allowSystemRoleRoute('Разработчик', 'POST', root + '/runs')).toBe(false);
        expect(allowSystemRoleRoute('Главный админ', 'POST', run + '/exec')).toBe(false);
        expect(allowSystemRoleRoute('Главный админ', 'POST', '/api/system-roles/unknown/runs')).toBe(false);
    });
});
