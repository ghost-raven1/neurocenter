import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';

describe('Доступ к личной очереди и повтор отмены',()=>{
    const actor={email:'owner@example.test',activeRole:'Наблюдатель'};
    const claims={email:actor.email,userRoles:['Наблюдатель'],projects:[{projectId:'prj-keep',projectName:'Доступный проект',role:'Наблюдатель'}]};
    const query=vi.fn(),transactionQuery=vi.fn(),readClaims=vi.fn();
    const service=new DeviceJobs({access:{claims:readClaims},pool:{query,connect:async()=>({query:transactionQuery,release:vi.fn()})}} as unknown as DeviceStore,
        {} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans);
    beforeEach(()=>{
        vi.resetAllMocks();readClaims.mockResolvedValue(claims);
        query.mockResolvedValue({rows:[],rowCount:0});transactionQuery.mockResolvedValue({rows:[],rowCount:0});
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    it('Список читает свежие назначения и ограничивает обе SQL-выборки до LIMIT истории',async()=>{
        await service.list(actor);
        expect(readClaims).toHaveBeenCalledWith(actor.email);
        expect(query).toHaveBeenCalledWith(expect.stringContaining("project_id IS NULL AND kind='choose-root'"),[actor.email,false,['prj-keep']]);
        const sql=query.mock.calls[0][0] as string;
        expect(sql.match(/project_id=ANY\(\$3::text\[\]\)/g)).toHaveLength(2);
        expect(sql).toContain("FROM bridge_jobs WHERE email=$1 AND ($2::boolean OR project_id=ANY($3::text[]) OR (project_id IS NULL AND kind='choose-root')) AND state NOT IN");
    });
    it('Последующее чтение не сохраняет старый набор проектов из кэша',async()=>{
        await service.list(actor);
        readClaims.mockResolvedValue({...claims,projects:[]});
        await service.list(actor);
        expect(query.mock.calls.at(-1)?.[1]).toEqual([actor.email,false,[]]);
    });
    it('Главный администратор сохраняет ограничение владельцем email',async()=>{
        readClaims.mockResolvedValue({...claims,userRoles:['Главный админ']});
        await service.list({...actor,activeRole:'Главный админ'});
        expect(query.mock.calls[0][1]).toEqual([actor.email,true,['prj-keep']]);
        expect(query.mock.calls[0][0]).toContain('WHERE email=$1');
    });
    it.each(['list','cancel'] as const)('Отозванная активная роль запрещает %s до SQL и инвалидации',async method=>{
        readClaims.mockResolvedValue({...claims,userRoles:[]});
        await expect(method==='list'?service.list(actor):service.cancel(actor,'job')).rejects.toMatchObject({status:403});
        expect(query).not.toHaveBeenCalled();expect(transactionQuery).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['list','cancel'] as const)('Отключённая учётная запись запрещает %s до SQL',async method=>{
        readClaims.mockRejectedValue(new ForbiddenException('Учётная запись отключена.'));
        await expect(method==='list'?service.list(actor):service.cancel(actor,'job')).rejects.toMatchObject({status:403});
        expect(query).not.toHaveBeenCalled();expect(transactionQuery).not.toHaveBeenCalled();
    });
    it('Потерянный ACK отмены не создаёт повторную запись или уведомление',async()=>{
        const row={id:'job',device_id:'computer',project_id:'prj-keep',email:actor.email,kind:'sync-rag',percent:30};
        let state='queued';
        transactionQuery.mockImplementation(async(sql:string)=>{
            if(sql.startsWith('UPDATE')&&state==='queued'){state='cancelled';return {rows:[row],rowCount:1};}
            return {rows:[],rowCount:0};
        });
        query.mockImplementation(async()=>({rows:[{state}]}));
        await expect(service.cancel(actor,row.id)).resolves.toEqual({ok:true});
        await expect(service.cancel(actor,row.id)).resolves.toEqual({ok:true});
        expect(transactionQuery.mock.calls.filter(([sql])=>sql.includes('INSERT INTO operations'))).toHaveLength(1);
        expect(fetch).toHaveBeenCalledOnce();
        expect(query.mock.calls[0][1]).toEqual([row.id,actor.email,false,['prj-keep']]);
    });
    it('Недоступный или чужой ID не отличается от отсутствующего при отмене',async()=>{
        await expect(service.cancel(actor,'foreign')).rejects.toMatchObject({status:404});
        expect(transactionQuery.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1]).toEqual(['foreign',actor.email,false,['prj-keep']]);
        expect(transactionQuery.mock.calls.some(([sql])=>sql.includes('INSERT INTO operations'))).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['running','reconciling','failed','succeeded'])('Отмена не подменяет состояние %s',async state=>{
        query.mockResolvedValue({rows:[{state}]});
        await expect(service.cancel(actor,'job')).rejects.toMatchObject({status:409});
        expect(transactionQuery.mock.calls.some(([sql])=>sql.includes('INSERT INTO operations'))).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
});
