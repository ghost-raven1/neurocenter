import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceJobs } from '../src/devices/device-jobs';
import { assertInstallationSetBridge } from '../src/devices/device-compatibility';
import type { Device, DeviceStore } from '../src/devices/device-store';
import type { DeviceArtifacts } from '../src/devices/device-artifacts';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';

describe('Старый MCP не обходит реестр владельцев одиночной установкой', () => {
    const actor = { email: 'owner@example.test', activeRole: 'Разработчик' };
    const binding = 'b'.repeat(64);
    const oldDevice: Device = { id: 'computer', email: actor.email, role: actor.activeRole, name: 'Тестовый MCP',
        fingerprint: 'a'.repeat(64), last_seen: null, revoked: false,
        report: { protocolVersion: 2, bridgeVersion: '0.4.1', capabilities: ['durable-completions', 'managed-installations', 'package-v4'],
            bindings: [{ projectId: 'prj-own', bindingId: binding, valid: true }] } };
    const pkg = { schemaVersion: 4, plugin: { id: 'project-prj-own/helper', kind: 'skill', version: 1 }, manifest: { sha256: 'a'.repeat(64) } };
    const job = { id: 'job', device_id: oldDevice.id, email: actor.email, role: actor.activeRole, project_id: 'prj-own', kind: 'install',
        payload: { assetKind: 'skill', assetId: pkg.plugin.id, version: 1, bindingId: binding, package: pkg, planId: 'plan', planRevision: 1 } };
    const query = vi.fn(); const owned = vi.fn(); const delivery = vi.fn(); const removalPackage = vi.fn();
    const service = new DeviceJobs({ pool: { query, connect: async () => ({ query, release: vi.fn() }) }, owned } as unknown as DeviceStore,
        {} as DeviceArtifacts, { removalPackage } as unknown as DeviceInstallations, { delivery, package: delivery } as unknown as InstallPlans);
    beforeEach(() => {
        query.mockReset(); owned.mockReset(); delivery.mockReset(); removalPackage.mockReset(); vi.restoreAllMocks();
        owned.mockResolvedValue(oldDevice); query.mockResolvedValue({ rows: [], rowCount: 0 }); delivery.mockResolvedValue(pkg);
        vi.spyOn(service as unknown as { permission(): Promise<unknown> }, 'permission').mockResolvedValue({});
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    it.each(['install', 'uninstall'])('Отклоняет создание single %s на MCP 0.4 до выбора пакета', async kind => {
        await expect(service.create(actor, { deviceId: oldDevice.id, projectId: 'prj-own', kind, requestKey: '11111111-1111-1111-1111-111111111111' }))
            .rejects.toMatchObject({ status: 409 });
        expect(delivery).not.toHaveBeenCalled(); expect(removalPackage).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false);
    });
    it.each(['install', 'uninstall'])('Отклоняет выдачу старого queued single %s клиенту 0.4', async kind => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.includes("state='queued'") && sql.startsWith('SELECT') ? [{ ...job, kind }] : [], rowCount: 0 }));
        const update = vi.spyOn(service, 'update');
        expect(await service.claim(oldDevice)).toBeNull();
        expect(update).not.toHaveBeenCalled();
        expect(query.mock.calls.find(([sql]) => sql.startsWith("UPDATE bridge_jobs SET state='failed'"))?.[1])
            .toEqual([job.id,oldDevice.id,expect.any(String),'Действие недоступно: доступ, привязка, одобрение или версия MCP изменились.']);
        expect(delivery).not.toHaveBeenCalled();
    });
    it.each(['install', 'uninstall'])('Отклоняет повторную авторизацию single %s после downgrade', async kind => {
        query.mockResolvedValue({ rows: [{ ...job, kind }] });
        await expect(service.authorize(oldDevice, job.id, 'lease')).rejects.toMatchObject({ status: 409 });
        expect(delivery).not.toHaveBeenCalled();
    });
    it('Новый MCP принимает старое queued single задание без installSet', async () => {
        const device = { ...oldDevice, report: { ...oldDevice.report, bridgeVersion: '0.5.0',
            capabilities: [...oldDevice.report.capabilities as string[], 'install-set-v1'] } };
        query.mockImplementation(async (sql: string) => ({ rows: sql.includes("state='queued'") && sql.startsWith('SELECT') ? [job] : [], rowCount: 0 }));
        expect(await service.claim(device)).toMatchObject({ id: job.id, state: 'running' });
        expect(delivery).toHaveBeenCalled();
        expect(query.mock.calls.find(([sql])=>sql.startsWith("UPDATE bridge_jobs SET state='running'"))?.[0]).toContain("message='Мост принял задание'");
        expect(JSON.parse(query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))?.[1][8])[0].message).toBe('Мост принял задание');
    });
    it('Номер версии без capability не выдаёт разрешение обходить ledger', () => {
        expect(() => assertInstallationSetBridge({ bridgeVersion: '0.5.0', capabilities: [] })).toThrow('Обновите');
        expect(() => assertInstallationSetBridge({ capabilities: ['install-set-v1'] })).not.toThrow();
    });
});
