import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { INSPECTION_ISSUES, assertInstallationInspection } from '../src/devices/installation-inspection';
import { completeDeviceJob } from '../src/devices/device-completion';

const bindingId = 'b'.repeat(64);
const source = { projectId: 'project', bindingId, package: { plugin: { id: 'ai-plug-helper', kind: 'mcp', version: 1 }, manifest: { sha256: 'a'.repeat(64) } } };
const result = { schemaVersion: 1, projectId: source.projectId, bindingId, assetId: source.package.plugin.id, assetKind: 'mcp',
    version: 1, manifest: source.package.manifest.sha256, checkedAt: '2026-10-17T10:00:00.000Z', readiness: 'unverified',
    state: 'checked', status: 'synced', issues: [] };

describe('Строгий безопасный результат сверки установки', () => {
    it('Принимает точную сверку файлов без заявления о запуске', () => {
        expect(() => assertInstallationInspection(result,source)).not.toThrow();
    });
    it.each([
        {projectId:'foreign'},{bindingId:'c'.repeat(64)},{assetId:'ai-plug-foreign'},{assetKind:'plugin'},
        {version:2},{manifest:'c'.repeat(64)},{schemaVersion:2},{readiness:'ready'},
        {checkedAt:'2026-02-31T10:00:00.000Z'},{checkedAt:'вчера'},{status:'ready'},{state:'unknown'},
        {issues:['/Users/private/secret']},{issues:['file-modified']},{issues:null},
        {config:{token:'секрет'}},{path:'/Users/private'},{ownerKeys:['a'.repeat(24)]},
    ])('Отклоняет подмену исходной установки или лишние данные: %j', change => {
        expect(() => assertInstallationInspection({...result,...change},source)).toThrow();
    });
    it.each(INSPECTION_ISSUES)('Принимает только известную обезличенную причину %s', issue => {
        expect(() => assertInstallationInspection({...result,status:'unknown',issues:[issue]},source)).not.toThrow();
    });
    it('Не принимает дубли причин или несогласованный статус занятого проекта', () => {
        for (const change of [{status:'unknown',issues:['read-failed','read-failed']},{state:'busy'},
            {state:'busy',status:'unknown',issues:['file-modified']},{status:'modified',issues:[]}]) {
            expect(() => assertInstallationInspection({...result,...change},source)).toThrow();
        }
        expect(() => assertInstallationInspection({...result,state:'busy',status:'unknown',issues:['inspection-busy']},source)).not.toThrow();
        expect(() => assertInstallationInspection({...result,state:'busy',status:'unknown',issues:['binding-changed']},source)).not.toThrow();
    });
    it('Не подтверждает успешную сверку неуспешным заданием', () => {
        expect(() => assertInstallationInspection(result,source,true)).toThrow();
        expect(() => assertInstallationInspection({...result,status:'unknown',issues:['inspection-failed']},source,true)).not.toThrow();
    });
});

describe('Доставка сверки после обрыва и безопасный журнал', () => {
    const query = vi.fn();
    const pool = {connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
    const job = {id:'job',email:'owner@example.test',project_id:source.projectId,kind:'inspect-installation',state:'reconciling',
        lease_until:new Date(0),payload:{bindingId,package:source.package},percent:0};
    const input = {lease:'lease',state:'succeeded' as const,message:'/Users/private/секрет не сохраняется',result};
    beforeEach(() => {
        query.mockReset();query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[job]:[]}));
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    it('Принимает полный результат после аренды и заменяет сообщение фиксированным', async () => {
        await expect(completeDeviceJob(pool,'device','job',input)).resolves.toMatchObject({ok:true});
        const saved = query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1];
        expect(saved).toEqual(['job','succeeded',100,'Сверка файлов завершена; запуск в OpenCode не проверен.',result]);
        expect(query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))?.[1][1]).toBe('VERIFY');
        expect(query.mock.calls.some(([,params])=>JSON.stringify(params ?? null).includes('/Users/private'))).toBe(false);
    });
    it('Неверная привязка не меняет историю при действующей аренде', async () => {
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...job,state:'running',lease_until:new Date(Date.now()+60000)}]:[]}));
        await expect(completeDeviceJob(pool,'device','job',{...input,result:{...result,bindingId:'c'.repeat(64)}})).rejects.toMatchObject({status:409});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Поздний повтор идентичен и не создаёт вторую операцию', async () => {
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...job,state:'succeeded',result}]:[]}));
        await expect(completeDeviceJob(pool,'device','job',input)).resolves.toEqual({ok:true,repeated:true});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.startsWith('INSERT'))).toBe(false);
    });
    it('Не сохраняет содержимое или настройки даже внутри корректной квитанции', async () => {
        await expect(completeDeviceJob(pool,'device','job',{...input,result:{...result,config:{secret:'ключ'}}})).rejects.toMatchObject({status:409});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
});
