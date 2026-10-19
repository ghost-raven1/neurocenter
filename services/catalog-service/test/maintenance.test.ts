import {beforeEach,describe,expect,it,vi} from 'vitest';
import {MaintenanceService} from '../src/maintenance/maintenance.service';
import {MaintenanceController} from '../src/maintenance/maintenance.controller';
import {defaultPolicy} from '../../shared/maintenance-policy.cjs';
import type {AccessDb} from '../src/access/access-db';
import type {Request} from 'express';
const mock=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),audit:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query:mock.query,connect:async()=>({query:mock.query,release:mock.release}),end:vi.fn()})}));
vi.mock('../src/access/security-events',()=>({setupSecurityEvents:vi.fn(),securityEvent:mock.audit}));
describe('Настройки обслуживания',()=>{
    beforeEach(()=>{vi.clearAllMocks();mock.query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT revision')?{rows:[{revision:2,policy:defaultPolicy}]}:sql.startsWith('UPDATE maintenance')?{rows:[{revision:3}]}:{rows:[]});});
    it('Сохранение и аудит выполняются в одной транзакции',async()=>{const service=new MaintenanceService();expect(await service.save({expectedRevision:2,policy:defaultPolicy},'admin@example.test')).toMatchObject({revision:3});expect(mock.audit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({actor:'admin@example.test',action:'maintenance.policy.update'}));expect(mock.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');});
    it('Устаревшая ревизия отклоняется без перезаписи и аудита',async()=>{await expect(new MaintenanceService().save({expectedRevision:1,policy:defaultPolicy},'admin')).rejects.toMatchObject({status:409});expect(mock.audit).not.toHaveBeenCalled();expect(mock.query).toHaveBeenLastCalledWith('ROLLBACK');});
    it('Ошибка аудита откатывает настройки',async()=>{mock.audit.mockRejectedValueOnce(new Error('audit unavailable'));await expect(new MaintenanceService().save({expectedRevision:2,policy:defaultPolicy},'admin')).rejects.toThrow('audit unavailable');expect(mock.query).toHaveBeenLastCalledWith('ROLLBACK');expect(mock.release).toHaveBeenCalled();});
    it('Отозванные права и роль администратора проекта блокируют прямой вызов',async()=>{
        process.env.NEUROCENTER_INTERNAL_TOKEN='fixture-internal';const access={claims:vi.fn().mockResolvedValue({email:'admin@example.test',userRoles:['Админ проекта']})};const service={get:vi.fn(),save:vi.fn()};const controller=new MaintenanceController(service as unknown as MaintenanceService,access as unknown as AccessDb);
        const req={headers:{'x-neurocenter-internal':'fixture-internal','x-bridge-actor':encodeURIComponent(JSON.stringify({email:'admin@example.test',activeRole:'Главный админ'}))}} as unknown as Request;
        await expect(controller.save(req,{expectedRevision:0,policy:defaultPolicy})).rejects.toMatchObject({status:403});expect(service.save).not.toHaveBeenCalled();
        access.claims.mockResolvedValue({email:'admin@example.test',userRoles:['Главный админ']});await controller.save(req,{expectedRevision:0,policy:defaultPolicy});expect(service.save).toHaveBeenCalledWith(expect.anything(),'admin@example.test');delete process.env.NEUROCENTER_INTERNAL_TOKEN;
    });

    it('Некорректная внешняя точка данных не скрывает превышение RPO через NaN',async()=>{
        mock.query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT revision')?{rows:[{revision:2,policy:defaultPolicy}]}:sql.startsWith('SELECT receipt')?{rows:[{receipt:{createdAt:'broken',verifiedAt:'2026-10-18T00:00:00Z',storageId:'external',backupId:'copy'}}]}:{rows:[]});
        const status=await new MaintenanceService().get();expect(status.external).toBeNull();expect(status.externalAgeSeconds).toBeNull();expect(status.rpoExceeded).toBe(true);
    });
    it('Следующее время не повторяет уже выполненный локальный слот при возврате DST',async()=>{
        vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-01T05:31:00Z'));
        const policy={...defaultPolicy,enabled:true,timeZone:'America/New_York',schedule:{days:[7],time:'01:30'}};
        mock.query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT revision')?{rows:[{revision:2,policy}]}:sql.startsWith('SELECT id,slot')?{rows:[{state:'succeeded',slot:'2026-11-01T01:30@America/New_York'}]}:{rows:[]});
        try{expect((await new MaintenanceService().get()).nextRunAt).toBe('2026-11-08T06:30:00.000Z');}finally{vi.useRealTimers();}
    });

});
