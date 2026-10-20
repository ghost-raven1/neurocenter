import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceJobs } from '../src/devices/device-jobs';
import { DeviceStore, type Device } from '../src/devices/device-store';
import type { DeviceArtifacts } from '../src/devices/device-artifacts';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';
import type { ProjectEmbeddingService } from '../src/models/project-embedding.service';

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../src/devices/device-enqueue', () => ({ enqueueDeviceJob: enqueue }));

describe('Доступ к повторному подключению папки через существующий мост', () => {
    const actor = { email: 'owner@example.test', activeRole: 'Разработчик' };
    const device: Device = { id: 'computer', email: actor.email, role: actor.activeRole, name: 'Компьютер', fingerprint: 'a'.repeat(64), last_seen: null, revoked: false,
        report: { protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'workspace-instance-v1'],
            bindings: [{ projectId: 'project', folderName: 'проект', valid: false, identityStatus: 'changed' }] } };
    const query = vi.fn(), claims = vi.fn();
    const store = { pool: { query }, access: { claims }, owned: DeviceStore.prototype.owned } as unknown as DeviceStore;
    const jobs = new DeviceJobs(store, {} as DeviceArtifacts, {} as DeviceInstallations, {} as InstallPlans, {} as ProjectEmbeddingService);
    const input = { deviceId: device.id, projectId: 'project', folderName: 'проект', bindingMode: 'new',
        kind: 'prepare-bind-project', requestKey: '11111111-1111-4111-8111-111111111111' };
    beforeEach(() => {
        vi.clearAllMocks(); enqueue.mockResolvedValue({ id: 'created' });
        query.mockImplementation(async (sql: string, values?: unknown[]) => ({ rows: sql.includes('FROM bridge_devices') && values?.[1] === actor.email ? [device] : [],
            rowCount: sql === 'SELECT 1 FROM projects WHERE id=$1' ? 1 : 0 }));
        claims.mockResolvedValue({ email: actor.email, userRoles: ['Разработчик'], projects: [{ projectId: 'project', projectName: 'Проект', role: 'Разработчик' }] });
    });

    it('Владелец с правами проекта проверяет изменённую служебную привязку без удаления устройства', async () => {
        await expect(jobs.create(actor, input)).resolves.toEqual({ id: 'created' });
        expect(enqueue).toHaveBeenCalledWith(store.pool, expect.any(String), expect.objectContaining({ deviceId: device.id, projectId: 'project',
            payload: expect.objectContaining({ mode: 'new', folderName: 'проект' }) }), expect.any(Function));
    });

    it('Другой владелец не создаёт задание на чужом мосте', async () => {
        await expect(jobs.create({ ...actor, email: 'another@example.test' }, input)).rejects.toMatchObject({ status: 403 });
        expect(enqueue).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledWith(expect.stringContaining('email=$2'), [device.id, 'another@example.test', false]);
    });

    it('При отсутствии доступа к выбранному проекту восстановление не ставится в очередь', async () => {
        claims.mockResolvedValue({ userRoles: ['Разработчик'], projects: [{ projectId: 'another-project', role: 'Разработчик' }] });
        await expect(jobs.create(actor, input)).rejects.toMatchObject({ status: 403 });
        expect(enqueue).not.toHaveBeenCalled();
    });
});
