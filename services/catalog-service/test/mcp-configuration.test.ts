import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { buildPackage } from '../src/catalog/bundle-package';
import { assertConfigurationReport,configurationSchemaDigest,validConfigurationRevisions } from '../src/devices/mcp-config-reports';
import { mcpConfigurationJobPayload,assertMcpConfigurationJob } from '../src/devices/mcp-config-jobs';
import { authorizeMcpConfigurationSave } from '../src/devices/mcp-config-permit';
import { readConfigurationState,assertRuntimeConfigurationRevisions } from '../src/devices/mcp-config-status';
import type { Device,DeviceStore } from '../src/devices/device-store';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';
import { completeDeviceJob } from '../src/devices/device-completion';
import { localConfigurationDigest as clientDigest,parseLocalConfiguration as clientSchema } from '../../../mcp/neurocenter-asset-sync/src/features/local-configuration/schema';
import { parseLocalConfiguration as serverSchema } from '../src/devices/mcp-config-schema';

const projectId='project',bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
const preparationId='22222222-2222-4222-8222-222222222222',serverPreparationId='33333333-3333-4333-8333-333333333333';
const revision='44444444-4444-4444-8444-444444444444';
const schema={schemaVersion:1,fields:[{id:'token',label:'Ключ доступа',type:'string',required:true,secret:true,target:{kind:'env',name:'TEST_TOKEN'}}]};
const pkg=buildPackage({id:'mcp',name:'Проверка',kind:'mcp',version:1},[{path:'index.mjs',content:'export default {};'}],'now',
    {transport:'stdio',command:'node',entrypoint:'index.mjs',extra:{localConfiguration:schema}});
const schemaDigest=configurationSchemaDigest(pkg)!;
const tuple={schemaVersion:1,projectId,bindingId,instanceId,assetId:'mcp',assetKind:'mcp',version:1,manifest:pkg.manifest.sha256,schemaDigest};
const source={projectId,bindingId,instanceId,package:pkg,schemaDigest,configurationPreparationId:preparationId};
const status=(ready=true)=>({...tuple,ready,missingFieldIds:ready?[]:['token'],revision:ready?revision:null,checkedAt:new Date().toISOString()});
const prepared=()=>({...tuple,preparationId,expiresAt:new Date(Date.now()+600_000).toISOString()});

describe('Публичный контракт настройки не принимает значения ключей',()=>{
    it('Сервер и MCP вычисляют один и тот же digest опубликованной схемы',()=>{
        expect(schemaDigest).toBe(clientDigest(clientSchema(pkg)!));
    });
    it.each(['__proto__','constructor','prototype','Constructor'])('Сервер и MCP запрещают reserved назначение %s',name=>{
        const changed=structuredClone(pkg);changed.config!.extra!.localConfiguration={...schema,fields:[{...schema.fields[0]!,target:{kind:'env',name}}]};
        expect(()=>serverSchema(changed)).toThrow();expect(()=>clientSchema(changed)).toThrow();
    });
    it('Сервер и MCP запрещают неиспользуемые env-параметры удалённого подключения',()=>{
        const changed=structuredClone(pkg);changed.config!.transport='remote';
        expect(()=>serverSchema(changed)).toThrow();expect(()=>clientSchema(changed)).toThrow();
    });
    it('Готовность и случайная ревизия принимаются без содержимого параметров',()=>{
        expect(()=>assertConfigurationReport('get-mcp-configuration-status',status(),source)).not.toThrow();
        expect(()=>assertConfigurationReport('get-mcp-configuration-status',status(false),source)).not.toThrow();
    });
    it.each([{values:{token:'секрет'}},{url:'http://127.0.0.1/#secret'},{headers:{authorization:'секрет'}},{secretHash:'f'.repeat(64)}])('Отвергает дополнительную передачу локальных данных: %j',changed=>{
        expect(()=>assertConfigurationReport('get-mcp-configuration-status',{...status(),...changed},source)).toThrow();
    });
    it.each([{instanceId:preparationId},{manifest:'b'.repeat(64)},{schemaDigest:'c'.repeat(64)},{assetId:'another'},{bindingId:'d'.repeat(64)}])('Чужой контекст не получает готовность: %j',changed=>{
        expect(()=>assertConfigurationReport('get-mcp-configuration-status',{...status(),...changed},source)).toThrow();
    });
    it('Нельзя заявить готовность с пропущенным обязательным полем или передать неизвестное поле',()=>{
        for(const changed of [{ready:true,missingFieldIds:['token']},{ready:false,missingFieldIds:[]},{ready:false,missingFieldIds:['unknown']},{ready:false,missingFieldIds:['token','token']}]){
            expect(()=>assertConfigurationReport('get-mcp-configuration-status',{...status(),...changed},source)).toThrow();
        }
    });
    it('Открытие подтверждает исходную подготовку и не раскрывает локальный URL',()=>{
        const result={...prepared(),opened:true};expect(()=>assertConfigurationReport('open-mcp-configuration',result,source)).not.toThrow();
        expect(()=>assertConfigurationReport('open-mcp-configuration',{...result,preparationId:serverPreparationId},source)).toThrow();
        expect(()=>assertConfigurationReport('open-mcp-configuration',{...result,url:'http://localhost'},source)).toThrow();
    });
    it('Ревизии графа не допускают дубликаты, другой порядок или отпечатки вместо UUID',()=>{
        const a={assetId:'a',manifest:'a'.repeat(64),revision};const b={assetId:'b',manifest:'b'.repeat(64),revision:null};
        expect(validConfigurationRevisions([a,b])).toBe(true);
        for(const changed of [[a,a],[b,a],[{...a,revision:'c'.repeat(64)}],[{...a,value:'секрет'}]])expect(validConfigurationRevisions(changed)).toBe(false);
    });
});

describe('Настройка закреплена за установленной версией и живым одобрением',()=>{
    const query=vi.fn(),inspectionPackage=vi.fn(),approvedConfiguration=vi.fn(),delivery=vi.fn();
    const store={pool:{query}} as unknown as DeviceStore;
    const installations={inspectionPackage} as unknown as DeviceInstallations;
    const plans={approvedConfiguration,delivery} as unknown as InstallPlans;
    const device={id:'computer',email:'owner@example.test',role:'Разработчик',report:{protocolVersion:2,capabilities:['workspace-instance-v1','local-mcp-config-v1','package-v5'],
        bindings:[{projectId,bindingId,instanceId,valid:true}]}} as Device;
    const approval={package:pkg,planId:serverPreparationId,planRevision:1,approvalManifest:pkg.manifest.sha256,approvalRoot:{kind:'mcp',id:'mcp',version:1}};
    const input={kind:'prepare-mcp-configuration',deviceId:device.id,projectId,requestKey:preparationId,assetId:'mcp',assetKind:'mcp',expectedManifest:pkg.manifest.sha256,expectedBindingId:bindingId};
    beforeEach(()=>{query.mockReset();inspectionPackage.mockReset();approvedConfiguration.mockReset();delivery.mockReset();inspectionPackage.mockResolvedValue(pkg);approvedConfiguration.mockResolvedValue(approval);delivery.mockResolvedValue({package:pkg});});
    it('Передаёт точный пакет и разрешение, а не последнюю карточку каталога',async()=>{
        const result=await mcpConfigurationJobPayload(store,installations,plans,device,input);
        expect(result).toMatchObject({...approval,bindingId,instanceId,schemaDigest});
        expect(inspectionPackage).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({expectedManifest:pkg.manifest.sha256}));
    });
    it('Не принимает значения вместе с идентификаторами подготовки',async()=>{
        await expect(mcpConfigurationJobPayload(store,installations,plans,device,{...input,values:{token:'секрет'}} as typeof input)).rejects.toMatchObject({status:400});
        expect(inspectionPackage).not.toHaveBeenCalled();
    });
    it('Открытие истёкшей подготовки не выполняется',async()=>{
        query.mockResolvedValue({rows:[{result:{...prepared(),expiresAt:'2020-01-01T00:00:00.000Z'},payload:approval}]});
        await expect(mcpConfigurationJobPayload(store,installations,plans,device,{...input,kind:'open-mcp-configuration',configurationPreparationJobId:serverPreparationId,expectedConfigurationSchemaDigest:schemaDigest})).rejects.toMatchObject({status:409});
    });
    it('Повторная авторизация замечает смену физического экземпляра',async()=>{
        await expect(assertMcpConfigurationJob(store,installations,plans,device,{kind:'prepare-mcp-configuration',project_id:projectId,payload:{...approval,bindingId,instanceId:preparationId,schemaDigest}})).rejects.toMatchObject({status:409});
        expect(delivery).not.toHaveBeenCalled();
    });
    it('Отзыв одобрения запрещает действие после выдачи задания',async()=>{
        delivery.mockRejectedValue(new Error('Одобрение отозвано'));
        await expect(assertMcpConfigurationJob(store,installations,plans,device,{kind:'prepare-mcp-configuration',project_id:projectId,payload:{...approval,bindingId,instanceId,schemaDigest}})).rejects.toThrow('Одобрение отозвано');
    });
    it('Перед сохранением закрытой формы повторно проверяет права и не меняет результат ACK',async()=>{
        const permission=vi.fn().mockRejectedValue(new Error('Роль отозвана'));
        query.mockResolvedValue({rows:[{id:preparationId,kind:'open-mcp-configuration',role:'Разработчик',project_id:projectId,payload:{...approval,bindingId,instanceId,schemaDigest}}]});
        await expect(authorizeMcpConfigurationSave(store,installations,plans,device,{jobId:preparationId},permission)).rejects.toThrow('Роль отозвана');
        expect(query.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE'))).toBe(false);
    });
    it('Разрешение после ACK не продлевает TTL и повторно проверяет устройство непосредственно в UPDATE',async()=>{
        const expiry=new Date(Date.now()+600_000).toISOString();const payload={...approval,bindingId,instanceId,schemaDigest,configurationPreparationJobId:serverPreparationId,configurationPreparationId:preparationId,configurationExpiresAt:expiry};
        query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT *')?{rows:[{id:preparationId,kind:'open-mcp-configuration',state:'succeeded',role:'Разработчик',project_id:projectId,payload}]}:
            sql.startsWith('SELECT result')?{rows:[{result:{...prepared(),expiresAt:expiry},payload:approval}]}:{rows:[{id:preparationId}],rowCount:1});
        const permission=vi.fn().mockResolvedValue(undefined);
        await expect(authorizeMcpConfigurationSave(store,installations,plans,device,{jobId:preparationId},permission)).resolves.toEqual({ok:true});
        const update=query.mock.calls.find(([sql])=>String(sql).startsWith('UPDATE'))![0];
        expect(update).toContain("COALESCE(payload->'configurationInvalidatedAt'");expect(update).toContain("configurationExpiresAt')::timestamptz>clock_timestamp()");
        expect(update).toContain('NOT active_device.revoked');expect(update).toContain('active_device.expires_at>clock_timestamp()');
        expect(update).not.toContain('SET result');expect(permission).toHaveBeenCalledOnce();
    });
    it('Истёкший или отозванный контекст между проверкой и UPDATE не получает разрешение записи',async()=>{
        const expiry=new Date(Date.now()+600_000).toISOString();const payload={...approval,bindingId,instanceId,schemaDigest,configurationPreparationJobId:serverPreparationId,configurationPreparationId:preparationId,configurationExpiresAt:expiry};
        query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT *')?{rows:[{id:preparationId,kind:'open-mcp-configuration',role:'Разработчик',project_id:projectId,payload}]}:
            sql.startsWith('SELECT result')?{rows:[{result:{...prepared(),expiresAt:expiry},payload:approval}]}:{rows:[],rowCount:0});
        await expect(authorizeMcpConfigurationSave(store,installations,plans,device,{jobId:preparationId},async()=>{})).rejects.toMatchObject({status:409});
    });
    it('Поздний ready не переживает маркер сохранения и повреждённый ответ статуса',async()=>{
        const invalidatedAt=new Date().toISOString();query.mockResolvedValue({rows:[{invalidatedAt,state:'succeeded',result:{...status(),values:{token:'секрет'}}}]});
        await expect(readConfigurationState(store.pool,device.email,{deviceId:device.id,projectId,bindingId,instanceId,package:pkg})).resolves.toEqual({invalidatedAt});
        expect(query.mock.calls[0][0]).toContain('checked.started_at');
    });
    it('Смена ревизии зависимости отменяет старое согласие на запуск всего комплекта',async()=>{
        query.mockResolvedValue({rows:[{state:'succeeded',result:status()}]});
        await expect(assertRuntimeConfigurationRevisions(store.pool,device.email,device.id,projectId,{package:pkg,bindingId,instanceId,
            configurationRevisions:[{assetId:'mcp',manifest:pkg.manifest.sha256,revision:preparationId}]})).rejects.toMatchObject({status:409});
    });
});

describe('Квитанция настройки после обрыва не передаёт секреты',()=>{
    const query=vi.fn();const pool={connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
    beforeEach(()=>{query.mockReset();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));});
    afterEach(()=>vi.unstubAllGlobals());
    it('Поздний статус принимается один раз, а повтор не записывает новый результат',async()=>{
        const result=status();const row={id:'job',device_id:'computer',email:'owner@example.test',project_id:projectId,kind:'get-mcp-configuration-status',state:'succeeded',result,
            lease_until:new Date(0),payload:{package:pkg,bindingId,instanceId,schemaDigest}};
        query.mockResolvedValue({rows:[row]});
        await expect(completeDeviceJob(pool,'computer','job',{lease:'lease',state:'succeeded',message:'секрет_не_записывается',result})).resolves.toEqual({ok:true,repeated:true});
        expect(query.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE'))).toBe(false);
    });
    it('Произвольный message не попадает в operation при ошибке настройки',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{id:'job',device_id:'computer',email:'owner@example.test',project_id:projectId,kind:'open-mcp-configuration',state:'running',
            lease_until:new Date(Date.now()+60_000),payload:{package:pkg,bindingId,instanceId,schemaDigest}}]:[]}));
        await completeDeviceJob(pool,'computer','job',{lease:'lease',state:'failed',message:'ПЕРСОНАЛЬНЫЙ_КЛЮЧ',result:{}});
        expect(JSON.stringify(query.mock.calls)).not.toContain('ПЕРСОНАЛЬНЫЙ_КЛЮЧ');
    });
});
