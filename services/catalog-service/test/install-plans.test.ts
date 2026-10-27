import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallPlans } from '../src/devices/install-plans';
import type { DeviceStore } from '../src/devices/device-store';
import type { DeviceArtifacts } from '../src/devices/device-artifacts';
import { buildPackage } from '../src/catalog/bundle-package';
import type { InstallPlanRow } from '../src/devices/install-plan.model';

describe('Одобрение точной версии установочного плана', () => {
    const actor = { email: 'admin@example.test', activeRole: 'Главный админ' };
    const query = vi.fn(); const connect=vi.fn(); const claims = vi.fn(); const build = vi.fn();
    const service = new InstallPlans({ pool: { query, connect }, access: { claims } } as unknown as DeviceStore, { build } as unknown as DeviceArtifacts);
    const id = '12345678-1234-1234-1234-123456789abc';
    const pkg = buildPackage({ id: 'common/helper', name: 'helper', kind: 'skill', version: 1 }, [{ path: 'SKILL.md', content: 'Исходная инструкция' }], '2026-01-01');
    const row: InstallPlanRow = { id, project_id: 'prj-own', asset_kind: 'skill', asset_id: pkg.plugin.id, version: 1, manifest: pkg.manifest.sha256, package: pkg, status: 'approved', revision: 1, approved_by: actor.email };
    let assigned=pkg;
    beforeEach(() => { assigned=pkg;connect.mockResolvedValue({query,release:vi.fn()});query.mockReset(); claims.mockReset(); build.mockReset(); query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM project_assets')?[{project_id:'prj-own',asset_id:assigned.plugin.id,asset_kind:assigned.plugin.kind,asset_version:assigned.plugin.version,asset_manifest:assigned.manifest.sha256,pin_snapshot:{package:assigned}}]:[row],rowCount:1}));
        claims.mockResolvedValue({ email: actor.email, userRoles: ['Главный админ'], projects: [] }); build.mockResolvedValue(pkg); });
    it('Выдаёт сохранённые байты без повторного чтения изменяемого каталога', async () => {
        expect(await service.package(id, 'prj-own', 'skill', 'common/helper', 1, 1, row.manifest)).toEqual(pkg);
        expect(build).not.toHaveBeenCalled();
    });
    it.each(['pending','revoked'] as const)('Статус %s не разрешает запись файлов', async status => {
        query.mockResolvedValue({ rows: [{ ...row, status }] });
        await expect(service.package(id, 'prj-own', 'skill', 'common/helper', 1, 1)).rejects.toMatchObject({ status: 409 });
    });
    it.each([
        ['другой проект', 'prj-other', 'skill', 'common/helper', 1, 1, row.manifest],
        ['другой вид', 'prj-own', 'plugin', 'common/helper', 1, 1, row.manifest],
        ['другой инструмент', 'prj-own', 'skill', 'common/other', 1, 1, row.manifest],
        ['другая версия', 'prj-own', 'skill', 'common/helper', 2, 1, row.manifest],
        ['отозванная ревизия', 'prj-own', 'skill', 'common/helper', 1, 3, row.manifest],
        ['другой хэш', 'prj-own', 'skill', 'common/helper', 1, 1, 'f'.repeat(64)],
    ])('Останавливает подмену: %s', async (_name, project, kind, asset, version, revision, manifest) => {
        await expect(service.package(id, project as string, kind, asset, version, revision, manifest)).rejects.toMatchObject({ status: 409 });
    });
    it('Старое задание без плана не получает неявного разрешения', async () => {
        await expect(service.package(undefined, 'prj-own', 'skill', 'common/helper', 1, 1)).rejects.toMatchObject({ status: 409 });
        expect(query).not.toHaveBeenCalled();
    });
    it.each([{}, {toString:null}, [], null])('Неверный тип хэша получает 400 до обращения к базе: %j',async expectedManifest=>{
        await expect(service.decide(actor,id,{expectedManifest,expectedRevision:0} as unknown as {expectedManifest:string;expectedRevision:number},'approved')).rejects.toMatchObject({status:400});
        expect(query).not.toHaveBeenCalled();
    });
    it.each([null, { ...pkg, files: [] }, { ...pkg, plugin: { ...pkg.plugin, id: 'other' } }])('Повреждённый JSONB останавливается до выдачи пакета', async packageValue => {
        query.mockResolvedValue({ rows: [{ ...row, package: packageValue }] });
        await expect(service.package(id, 'prj-own', 'skill', 'common/helper', 1, 1)).rejects.toMatchObject({ status: 409 });
    });
    it.each([{ mcp: ['server'], plugins: [] }, { mcp: [], plugins: ['plugin'] }, { mcp: 'server', plugins: [] }])('Неразрешённые зависимости не превращаются в частичную установку', async requirements => {
        assigned=buildPackage(pkg.plugin, pkg.files, '2026-01-01', { extra: { requirements } });
        await expect(service.prepare(actor, { projectId: 'prj-own', assetKind: 'skill', assetId: 'common/helper', version: 1 })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO device_install_plans'))).toBe(false);
    });
    it('Отсутствующий plugin entrypoint даёт 409 до записи плана или получения разрешения enqueue', async () => {
        connect.mockClear();
        assigned=buildPackage({id:'ai-plug-own-missing-entry',name:'Плагин QA',kind:'plugin',version:7},
            [{path:'README.md',content:'Документация без исполняемой поставки'}],'now',null);
        const before=JSON.stringify(assigned);
        await expect(service.prepare(actor,{projectId:'prj-own',assetKind:'plugin',assetId:assigned.plugin.id,version:7})).rejects.toMatchObject({status:409});
        expect(connect).not.toHaveBeenCalled();expect(build).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([sql])=>/INSERT|UPDATE|DELETE/.test(String(sql)))).toBe(false);
        query.mockClear();
        query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM project_assets')?[{project_id:'prj-own',asset_id:assigned.plugin.id,asset_kind:'plugin',asset_version:7,asset_manifest:assigned.manifest.sha256,pin_snapshot:{package:assigned}}]:[{...row,asset_kind:'plugin',asset_id:assigned.plugin.id,version:7,manifest:assigned.manifest.sha256,package:assigned}],rowCount:1}));
        await expect(service.delivery(id,'prj-own','plugin',assigned.plugin.id,7,1,assigned.manifest.sha256)).rejects.toMatchObject({status:409});
        expect(JSON.stringify(assigned)).toBe(before);
    });
    it('Разработчик не одобряет собственный проектный скилл', async () => {
        claims.mockResolvedValue({ userRoles: ['Разработчик'], projects: [{ projectId: 'prj-own', role: 'Разработчик' }] });
        await expect(service.decide({ ...actor, activeRole: 'Разработчик' }, id, { expectedManifest: row.manifest, expectedRevision: 1 }, 'approved')).rejects.toMatchObject({ status: 403 });
    });
    it('Админ проекта не одобряет версию в другом проекте', async () => {
        claims.mockResolvedValue({ userRoles: ['Админ проекта'], projects: [{ projectId: 'prj-other', role: 'Админ проекта' }] });
        await expect(service.decide({ ...actor, activeRole: 'Админ проекта' }, id, { expectedManifest: row.manifest, expectedRevision: 1 }, 'approved')).rejects.toMatchObject({ status: 403 });
    });
    it('Событие обновления не раскрывает план участнику чужого проекта',async()=>{
        claims.mockResolvedValue({userRoles:['Наблюдатель'],projects:[{projectId:'prj-other',role:'Наблюдатель'}]});
        await expect(service.view({...actor,activeRole:'Наблюдатель'},id)).rejects.toMatchObject({status:403});
    });
    it('Просмотр включает код, а не только хэш файла', async () => {
        const plan = await service.prepare(actor, { projectId: 'prj-own', assetKind: 'skill', assetId: 'common/helper', version: 1 });
        expect(plan.files[0].content).toBe('Исходная инструкция');
        expect(plan.manifest).toBe(row.manifest);
    });
    it.each(['npx','uvx','/usr/local/bin/server'])('Внешняя команда %s не выдаётся за неизменяемый локальный код',async command=>{
        assigned=buildPackage({...pkg.plugin,kind:'mcp'},[],'2026-01-01',{transport:'stdio',command,args:['server@latest']});
        await expect(service.prepare(actor,{projectId:'prj-own',assetKind:'mcp',assetId:'common/helper',version:1})).rejects.toMatchObject({status:409});
    });
});
