import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { completeDeviceJob } from '../src/devices/device-completion';
import { workspaceJobPayload } from '../src/devices/workspace-jobs';
import { WORKSPACE_FAILURE_MESSAGES, workspaceFailureMessage } from '../src/devices/workspace-failure';
import { WORKSPACE_BINDING_FAILURE_CODES } from '../../../mcp/neurocenter-asset-sync/src/bridge/workspace-binding-error';
import type { Device, DeviceStore } from '../src/devices/device-store';
import type { DeviceInstallations } from '../src/devices/device-installations';

describe('Причины отказа привязки папки', () => {
    const query = vi.fn(), release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    const input = { lease: 'lease', state: 'failed' as const, message: '/Users/private/API_KEY=PRIVATE', result: {} };
    const row = { id: 'job', device_id: 'device', email: 'fixture@example.test', project_id: 'project', state: 'running',
        percent: 0, lease_until: new Date(Date.now() + 60000), payload: { mode: 'new', folderName: 'project', workspaceFailureVersion: 1 } };

    beforeEach(() => {
        query.mockReset(); release.mockClear();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('Сервер понимает все публичные коды моста', () => {
        expect(Object.keys(WORKSPACE_FAILURE_MESSAGES).sort()).toEqual([...WORKSPACE_BINDING_FAILURE_CODES].sort());
    });

    it.each(['prepare-bind-project', 'bind-project'])('Отказ %s сохраняет причину в задании и аудите без локальных данных', async kind => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind }] : [], rowCount: 1 }));
        for (const code of WORKSPACE_BINDING_FAILURE_CODES) {
            query.mockClear();
            const result = { workspaceFailure: code };
            await expect(completeDeviceJob(pool, 'device', 'job', { ...input, result })).resolves.toMatchObject({ ok: true });
            const saved = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE bridge_jobs'))?.[1];
            expect(saved?.[3]).toBe(WORKSPACE_FAILURE_MESSAGES[code]);
            expect(saved?.[4]).toEqual(result);
            const operation = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO operations'));
            expect(JSON.stringify(operation)).toContain(WORKSPACE_FAILURE_MESSAGES[code]);
            expect(JSON.stringify(query.mock.calls)).not.toContain('PRIVATE');
            expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
        }
    });

    it.each([
        { workspaceFailure: 'future-code' }, { workspaceFailure: '/private/secret' }, { workspaceFailure: 1 },
        { workspaceFailure: 'foreign-binding', path: '/private/secret' }, { error: 'PRIVATE' },
    ])('Неизвестная структура отказа не записывает данные: %j', async result => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind: 'bind-project' }] : [] }));
        await expect(completeDeviceJob(pool, 'device', 'job', { ...input, result })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT'))).toBe(false);
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    });

    it.each([undefined, 2])('Коды не принимаются без согласованной версии протокола %s', version => {
        expect(() => workspaceFailureMessage({ workspaceFailure: 'foreign-binding' }, version)).toThrow();
    });

    it.each([undefined, 1])('Старый мост с пустым отказом версии %s получает подтверждение и подсказку обновления', async version => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT')
            ? [{ ...row, kind: 'bind-project', payload: { ...row.payload, workspaceFailureVersion: version } }] : [], rowCount: 1 }));
        await expect(completeDeviceJob(pool, 'device', 'job', input)).resolves.toMatchObject({ ok: true });
        expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE bridge_jobs'))?.[1][3]).toContain('Мост не сообщил причину. Обновите мост');
    });

    it('Потерянный ответ не создаёт повторную операцию отказа', async () => {
        const result = { workspaceFailure: 'resume-required' };
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind: 'bind-project', state: 'failed', result }] : [] }));
        await expect(completeDeviceJob(pool, 'device', 'job', { ...input, result })).resolves.toEqual({ ok: true, repeated: true });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT'))).toBe(false);
    });

    it('Новые задания включают диагностику без изменения выбранной папки и режима', async () => {
        const device = { id: 'device', email: 'fixture@example.test', report: { capabilities: ['workspace-instance-v1'] } } as unknown as Device;
        const workspacePackages = vi.fn();
        const result = await workspaceJobPayload({} as DeviceStore, { workspacePackages } as unknown as DeviceInstallations,
            device, { kind: 'prepare-bind-project', projectId: 'project', folderName: 'project', bindingMode: 'new' });
        expect(result).toEqual({ folderName: 'project', mode: 'new', workspaceFailureVersion: 1, installations: [] });
        expect(workspacePackages).not.toHaveBeenCalled();
    });
});
