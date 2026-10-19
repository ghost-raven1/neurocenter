import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceInstallations } from '../src/devices/device-installations';
import { buildPackage } from '../src/catalog/bundle-package';
import type { DeviceStore } from '../src/devices/device-store';
import type { IAccessClaims } from '../src/access/access.model';

const actor = { email: 'user@example.test', activeRole: 'Разработчик' };
const claims: IAccessClaims = {
    email: actor.email,
    userRoles: ['Разработчик', 'Наблюдатель'],
    projects: [
        { projectId: 'mine', projectName: 'Мой', role: 'Разработчик' },
        { projectId: 'read', projectName: 'Чтение', role: 'Наблюдатель' },
    ],
    pluginIds: [],
    skillPaths: [],
};
describe('Серверный список и удаление личных установок', () => {
    const query = vi.fn();
    const claim = vi.fn();
    const service = new DeviceInstallations({
        pool: { query },
        access: { claims: claim },
    } as unknown as DeviceStore);
    const pkg = buildPackage(
        { id: 'test', name: 'test', kind: 'mcp', version: 1 },
        [{ path: 'index.mjs', content: 'fixture' }],
        new Date().toISOString(),
        { command: 'node', entrypoint: 'index.mjs' },
    );
    const input = {
        deviceId: 'computer',
        projectId: 'mine',
        assetId: 'test',
        assetKind: 'mcp',
        expectedManifest: pkg.manifest.sha256,
        bindingId: 'a'.repeat(64),
    };
    beforeEach(() => {
        query.mockReset();
        claim.mockReset();
        claim.mockResolvedValue(claims);
        query.mockResolvedValue({ rows: [] });
    });
    it('Читает только историю владельца и проекты из свежих назначений', async () => {
        await service.list(actor);
        expect(claim).toHaveBeenCalledWith(actor.email);
        expect(query.mock.calls[0][1]).toEqual([
            actor.email,
            false,
            ['mine', 'read'],
        ]);
        expect(query.mock.calls[0][0]).toContain("state='succeeded'");
        expect(query.mock.calls[0][0]).toContain('NOT d.revoked');
    });
    it('Отозванная роль не получает доступ к старым проектам', async () => {
        claim.mockResolvedValue({ ...claims, userRoles: ['Наблюдатель'] });
        await service.list(actor);
        expect(query.mock.calls[0][1]).toEqual([actor.email, false, []]);
    });
    it('Главный админ видит свои установки во всех проектах, не чужие компьютеры', async () => {
        claim.mockResolvedValue({ ...claims, userRoles: ['Главный админ'] });
        await service.list({ ...actor, activeRole: 'Главный админ' });
        expect(query.mock.calls[0][1]).toEqual([
            actor.email,
            true,
            ['mine', 'read'],
        ]);
    });
    it('Для удаления использует оригинальный успешный пакет после исключения из каталога', async () => {
        query.mockResolvedValue({
            rows: [{ kind: 'install', payload: { package: pkg, bindingId: input.bindingId } }],
        });
        expect(await service.removalPackage(actor, input)).toEqual(pkg);
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][1]).toEqual([
            actor.email,
            'computer',
            'mine',
            'test',
            'mcp',
            input.bindingId,
        ]);
    });
    it.each([
        undefined,
        { kind: 'uninstall', payload: { package: pkg, bindingId: 'a'.repeat(64) } },
        { kind: 'install', payload: { package: { ...pkg, files: [] }, bindingId: 'a'.repeat(64) } },
    ])(
        'Не удаляет отсутствующую, уже удалённую или повреждённую установку',
        async (row) => {
            query.mockResolvedValue({ rows: row ? [row] : [] });
            await expect(service.removalPackage(actor, input)).rejects.toThrow(
                'уже удалена или обновлена',
            );
        },
    );
    it('Изменившийся манифест требует обновить список', async () => {
        query.mockResolvedValue({
            rows: [{ kind: 'install', payload: { package: pkg, bindingId: input.bindingId } }],
        });
        await expect(
            service.removalPackage(actor, {
                ...input,
                expectedManifest: '0'.repeat(64),
            }),
        ).rejects.toThrow('обновлена');
    });
    it.each([
        { assetKind: 'unknown' },
        { assetId: '' },
        { expectedManifest: 'broken' },
    ])('Неполная команда отклоняется до обращения к БД', async (change) => {
        await expect(
            service.removalPackage(actor, { ...input, ...change }),
        ).rejects.toThrow('актуальную квитанцию');
        expect(query).not.toHaveBeenCalled();
    });
    it('Учитывает папку в ключе истории и выбирает только текущую привязку',async()=>{
        query.mockResolvedValue({rows:[{kind:'install',payload:{package:pkg,bindingId:input.bindingId}}]});
        await service.removalPackage(actor,input);
        expect(query.mock.calls[0][0]).toContain('DISTINCT ON (device_id,project_id,installed_binding,');
        expect(query.mock.calls[0][0]).toContain('AND installed_binding=$6');
        expect(query.mock.calls[0][1][5]).toBe(input.bindingId);
    });
    it('Read-only проверка использует точный сохранённый пакет текущей папки',async()=>{
        query.mockResolvedValue({rows:[{kind:'install',payload:{package:pkg,bindingId:input.bindingId}}]});
        expect(await service.inspectionPackage({...actor,activeRole:'Наблюдатель'},input)).toEqual(pkg);
        expect(query).toHaveBeenCalledTimes(1);expect(query.mock.calls[0][1][5]).toBe(input.bindingId);
    });
    it.each([undefined,'broken'])('Без доказуемой текущей папки не обращается к истории: %s',async bindingId=>{
        await expect(service.removalPackage(actor,{...input,bindingId})).rejects.toMatchObject({status:409});
        expect(query).not.toHaveBeenCalled();
    });
    it.each([undefined,'b'.repeat(64)])('Не использует legacy или квитанцию другой папки даже при совпадении SHA: %s',async bindingId=>{
        query.mockResolvedValue({rows:[{kind:'install',payload:{package:pkg,bindingId}}]});
        await expect(service.removalPackage(actor,input)).rejects.toMatchObject({status:409});
    });
    it('Список помечает только точную текущую папку, legacy не получает ложную привязку',async()=>{
        const bindings=[{projectId:'mine',bindingId:input.bindingId,folderName:'Проект А',valid:true}];
        query.mockResolvedValue({rows:[
            {assetId:'test',projectId:'mine',bindingId:input.bindingId,bindings},
            {assetId:'test',projectId:'mine',bindingId:'b'.repeat(64),bindings},
            {assetId:'legacy',projectId:'mine',bindingId:null,bindings},
        ]});
        const rows=await service.list(actor);
        expect(rows[0]).toMatchObject({isCurrentBinding:true,bindingChanged:false,folderName:'Проект А'});
        expect(rows[1]).toMatchObject({isCurrentBinding:false,bindingChanged:true});expect(rows[1].folderName).toBeUndefined();
        expect(rows[2]).toMatchObject({legacyBinding:true,isCurrentBinding:false,bindingChanged:true});expect(rows[2].folderName).toBeUndefined();
    });
    it('Долговременная сверка выбирается по точной привязке и текущему событию установки',async()=>{
        const inspection={schemaVersion:1,projectId:'mine',bindingId:input.bindingId,assetId:'test',assetKind:'mcp',version:1,manifest:pkg.manifest.sha256,
            checkedAt:'2026-10-17T00:00:00.000Z',readiness:'unverified',state:'checked',status:'synced',issues:[]};
        query.mockResolvedValue({rows:[{projectId:'mine',bindingId:input.bindingId,assetId:'test',assetKind:'mcp',version:1,manifest:pkg.manifest.sha256,inspection,bindings:[{projectId:'mine',bindingId:input.bindingId}]}]});
        expect((await service.list(actor))[0].inspection).toEqual(inspection);
        const sql=query.mock.calls[0][0];
        expect(sql).toContain("checked.payload->>'bindingId'=j.installed_binding");
        expect(sql).toContain("checked.payload->'package'->'manifest'->>'sha256'=j.installed_package->'manifest'->>'sha256'");
        expect(sql).toContain('COALESCE(checked.started_at,checked.created_at)>=COALESCE(j.started_at,j.created_at)');
        expect(sql).not.toContain('LIMIT 100');
    });
    it.each([{bindingId:'b'.repeat(64)},{assetId:'foreign'},{version:2},{readiness:'ready'},{config:{API_KEY:'не должен попасть в UI'}}])('Повреждённая, чужая или устаревшая сверка не выдаётся в списке: %j',async change=>{
        const inspection={schemaVersion:1,projectId:'mine',bindingId:input.bindingId,assetId:'test',assetKind:'mcp',version:1,manifest:pkg.manifest.sha256,
            checkedAt:'2026-10-17T00:00:00.000Z',readiness:'unverified',state:'checked',status:'synced',issues:[],...change};
        query.mockResolvedValue({rows:[{projectId:'mine',bindingId:input.bindingId,assetId:'test',assetKind:'mcp',version:1,manifest:pkg.manifest.sha256,inspection,bindings:[]}]});
        expect((await service.list(actor))[0].inspection).toBeUndefined();
    });
});
