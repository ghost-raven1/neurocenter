import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPackage } from '../src/catalog/bundle-package';
import type { DeviceArtifacts } from '../src/devices/device-artifacts';
import type { DeviceStore } from '../src/devices/device-store';
import { InstallPlans } from '../src/devices/install-plans';
import type { InstallPlanRow } from '../src/devices/install-plan.model';
import { installationRef, installationSetHash } from '../src/devices/installation-set';

const actor = { email: 'admin@example.test', activeRole: 'Главный админ' };
const id = '12345678-1234-1234-1234-123456789abc';
const project = 'prj-own';
const dependency = buildPackage({ kind: 'plugin', id: 'ai-plug-helper', name: 'helper', version: 2 },
    [{ path: 'index.ts', content: 'export default { name: "Помощник" }' }], 'then', { entrypoint: 'index.ts' });
const root = buildPackage({ kind: 'skill', id: 'common/helper', name: 'helper', version: 1 },
    [{ path: 'SKILL.md', content: 'Инструкция корня' }], 'then',
    { extra: { requirements: { mcp: [], plugins: [], dependencies: [installationRef(dependency)] } } });
const members = [root, dependency];
const installationSet = { schemaVersion: 1 as const, root: installationRef(root), packages: members,
    manifest: installationSetHash(installationRef(root), members) };
const approved: InstallPlanRow = { id, project_id: project, asset_kind: 'skill', asset_id: root.plugin.id, version: 1,
    manifest: installationSet.manifest, package: root, status: 'approved', revision: 1, approved_by: actor.email, installation_set: installationSet };

describe('Одобрение полного графа установки', () => {
    let saved: InstallPlanRow;
    let allowed: Set<string>;
    const query = vi.fn(); const build = vi.fn(); const claims = vi.fn(); const connect = vi.fn();
    const service = new InstallPlans({ pool: { query, connect }, access: { claims } } as unknown as DeviceStore, { build } as unknown as DeviceArtifacts);
    beforeEach(() => {
        saved = structuredClone(approved); allowed = new Set([root.plugin.id, dependency.plugin.id]);
        query.mockReset(); build.mockReset(); claims.mockReset(); connect.mockReset();
        connect.mockResolvedValue({query,release:vi.fn()});
        claims.mockResolvedValue({ email: actor.email, userRoles: ['Главный админ'], projects: [] });
        build.mockImplementation(async (_kind, assetId) => assetId === root.plugin.id ? root : dependency);
        query.mockImplementation(async (sql: string, parameters: unknown[]) => {
            if (sql.includes('FROM device_install_plans')) { return { rows: [saved], rowCount: 1 }; }
            if (sql.includes('FROM projects')) { return { rows: [], rowCount: 1 }; }
            if (sql.includes('FROM project_assets')) { return { rows: allowed.has(String(parameters[2]))?[{project_id:project,asset_kind:'skill',asset_id:root.plugin.id,asset_version:1,asset_manifest:root.manifest.sha256,pin_snapshot:{package:root}}]:[],rowCount:allowed.has(String(parameters[2]))?1:0 }; }
            if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('INSERT INTO security_events'))return {rows:[],rowCount:0};
            if (sql.startsWith('INSERT INTO device_install_plans')) {
                saved = { ...saved, id: String(parameters[0]), manifest: String(parameters[5]), package: parameters[6] as typeof root,
                    installation_set: parameters[8] as typeof installationSet, status: 'pending', revision: 0 };
                return { rows: [saved], rowCount: 1 };
            }
            throw new Error('Неожиданный SQL');
        });
    });

    it('Подготовка сохраняет корень и замкнутый комплект одним запросом', async () => {
        const plan = await service.prepare(actor, { projectId: project, assetKind: 'skill', assetId: root.plugin.id, version: 1 });
        expect(plan.manifest).toBe(installationSet.manifest);
        expect(plan.manifest).not.toBe(root.manifest.sha256);
        expect(plan.packages).toHaveLength(2);
        expect(plan.packages?.find(pkg => pkg.kind === 'plugin')?.files[0].content).toContain('Помощник');
        expect(build.mock.calls).toEqual([['plugin', dependency.plugin.id, 2]]);
        expect(saved.installation_set?.packages).toHaveLength(2);
    });
    it('Повторная выдача не перечитывает head ни корня, ни зависимости', async () => {
        const delivery = await service.delivery(id, project, 'skill', root.plugin.id, 1, 1, installationSet.manifest);
        expect(delivery.package).toEqual(root); expect(delivery.installSet).toEqual(installationSet);
        expect(build).not.toHaveBeenCalled();
    });
    it('Одобрение хэша только корня не разрешает полный комплект', async () => {
        await expect(service.delivery(id, project, 'skill', root.plugin.id, 1, 1, root.manifest.sha256)).rejects.toMatchObject({ status: 409 });
    });
    it('Dependency is authorized by approved root graph without a separate project assignment',async()=>{
        allowed.delete(dependency.plugin.id);
        expect((await service.delivery(id,project,'skill',root.plugin.id,1,1,installationSet.manifest)).installSet).toEqual(installationSet);
        const plan=await service.prepare(actor,{projectId:project,assetKind:'skill',assetId:root.plugin.id,version:1});
        expect(plan.packages).toHaveLength(2);
    });
    it.each(['pending', 'revoked'] as const)('Статус %s останавливает всю группу', async status => {
        saved.status = status;
        await expect(service.delivery(id, project, 'skill', root.plugin.id, 1, 1, installationSet.manifest)).rejects.toMatchObject({ status: 409 });
    });
    it('План с pins без сохранённого состава не превращается в одиночный пакет', async () => {
        saved.installation_set = null; saved.manifest = root.manifest.sha256;
        await expect(service.package(id, project, 'skill', root.plugin.id, 1, 1, saved.manifest)).rejects.toMatchObject({ status: 409 });
    });
    it('Изменение пакета внутри группы обнаруживается до её выдачи', async () => {
        saved.installation_set!.packages[1].files[0].content = 'Подмена плагина';
        await expect(service.delivery(id, project, 'skill', root.plugin.id, 1, 1, saved.manifest)).rejects.toMatchObject({ status: 409 });
    });
    it('Другая копия корневого пакета не подменяет корень сохранённой группы', async () => {
        saved.package = buildPackage(root.plugin, [{ path: 'SKILL.md', content: 'Другая инструкция' }], 'later', root.config);
        await expect(service.delivery(id, project, 'skill', root.plugin.id, 1, 1, saved.manifest)).rejects.toMatchObject({ status: 409 });
    });
    it('Состав проверяется до попытки одобрить повреждённый JSONB', async () => {
        saved.installation_set = { packages: {} } as never;
        await expect(service.decide(actor, id, { expectedManifest: saved.manifest, expectedRevision: 1 }, 'approved')).rejects.toMatchObject({ status: 409 });
        expect(connect).not.toHaveBeenCalled();
    });
    it('Removed root assignment cannot approve an earlier plan',async()=>{
        allowed.delete(root.plugin.id);
        await expect(service.decide(actor,id,{expectedManifest:saved.manifest,expectedRevision:1},'approved')).rejects.toMatchObject({status:403});
        expect(connect).toHaveBeenCalledOnce();
    });
});
