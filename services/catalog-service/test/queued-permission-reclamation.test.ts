import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ServiceUnavailableException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import {enqueueDeviceJob} from '../src/devices/device-enqueue';
import {hasDeviceJobPermission,jobMinimumLevel,reclaimUnauthorizedQueuedJobs,REVOKED_QUEUE_MESSAGE} from '../src/devices/device-job-access';

describe('Освобождение очереди после отзыва прав',()=>{
    const email='owner@example.test';
    const claims={email,userRoles:['Разработчик','Наблюдатель'],projects:[{projectId:'current',projectName:'Текущий',role:'Разработчик'},{projectId:'read',projectName:'Чтение',role:'Наблюдатель'}],pluginIds:[],skillPaths:[]};
    const device={id:'computer',email,role:'Разработчик'};
    const incoming={project_id:'current',kind:'sync-rag',role:'Разработчик'};
    const query=vi.fn(),readClaims=vi.fn();
    const client={query} as unknown as PoolClient;
    beforeEach(()=>{
        vi.resetAllMocks();readClaims.mockResolvedValue(claims);
        query.mockImplementation(async(sql:string,params:unknown[])=>({rows:sql.startsWith('SELECT id FROM projects')?[{id:'current'},{id:'read'}]
            :sql.startsWith('UPDATE')?(params[2] as string[]).map(id=>({id,email,...incoming})):[]}));
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    it('Под device lock читает только own queued metadata, а не started или payload',async()=>{
        await reclaimUnauthorizedQueuedJobs(client,device,incoming,readClaims);
        expect(query.mock.calls[0]).toEqual([expect.stringContaining("WHERE device_id=$1 AND email=$2 AND state='queued' ORDER BY id FOR UPDATE"),[device.id,email]]);
        expect(query.mock.calls[0][0]).not.toContain('payload');
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Отменяет только потерявшие проект задания и фиксирует точную причину той же SQL-сессией',async()=>{
        query.mockResolvedValueOnce({rows:[{id:'revoked',email,...incoming,project_id:'old'},{id:'valid',email,...incoming}]});
        await expect(reclaimUnauthorizedQueuedJobs(client,device,incoming,readClaims)).resolves.toBe(true);
        const changed=query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'));
        expect(changed?.[0]).toContain("AND state='queued'");
        expect(changed?.[1]).toEqual([device.id,email,['revoked'],REVOKED_QUEUE_MESSAGE]);
        expect(query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))?.[1].slice(5,7)).toEqual(['CANCELLED',0]);
        expect(query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))?.[1][8]).toContain(REVOKED_QUEUE_MESSAGE);
    });
    it('Низкая активная роль нового чтения не отменяет очередь с действующей сохранённой ролью разработчика',async()=>{
        query.mockResolvedValueOnce({rows:[{id:'valid',email,...incoming}]});
        await expect(reclaimUnauthorizedQueuedJobs(client,device,{...incoming,kind:'inspect-installation',role:'Наблюдатель'},readClaims)).resolves.toBe(false);
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Отозванная роль старого задания отменяется независимо от прав нового запроса',async()=>{
        query.mockResolvedValueOnce({rows:[{id:'old-main',email,...incoming,role:'Главный админ'}]});
        await reclaimUnauthorizedQueuedJobs(client,device,incoming,readClaims);
        expect(query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1][2]).toEqual(['old-main']);
    });
    it('Недоступная текущая роль устройства запрещает новый enqueue без отмены существующих заданий',async()=>{
        query.mockResolvedValueOnce({rows:[{id:'old',email,...incoming,project_id:'old'}]});
        await expect(reclaimUnauthorizedQueuedJobs(client,{...device,role:'Главный админ'},incoming,readClaims)).rejects.toMatchObject({status:403});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it('503 проверки прав не считается отзывом и не меняет ни одно задание',async()=>{
        query.mockResolvedValueOnce({rows:[{id:'old',email,...incoming,project_id:'old'}]});
        readClaims.mockRejectedValue(new ServiceUnavailableException('Назначения недоступны.'));
        await expect(reclaimUnauthorizedQueuedJobs(client,device,incoming,readClaims)).rejects.toMatchObject({status:503});
        expect(query).toHaveBeenCalledOnce();
    });
    it('Отозванный доступ нового запроса запрещает cleanup до первой записи',async()=>{
        query.mockResolvedValueOnce({rows:[{id:'old',email,...incoming,project_id:'old'}]});
        await expect(reclaimUnauthorizedQueuedJobs(client,device,{...incoming,project_id:'old'},readClaims)).rejects.toMatchObject({status:403});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.includes('INSERT INTO operations'))).toBe(false);
    });
    it('Правило выдачи учитывает обе роли и различает чтение и изменение',()=>{
        expect(hasDeviceJobPermission(claims,'Разработчик','Наблюдатель','current',jobMinimumLevel('sync-rag'))).toBe(false);
        for(const kind of ['inspect-installation','scan-project-inventory','list-local-variants','get-mcp-configuration-status']) {
            expect(hasDeviceJobPermission(claims,'Разработчик','Наблюдатель','current',jobMinimumLevel(kind))).toBe(true);
        }
    });
    it('Повтор requestKey возвращает прежний результат до fresh cleanup и не раскрывает внутренние поля',async()=>{
        const input={id:'new',deviceId:device.id,email,role:incoming.role,projectId:'current',kind:'sync-rag',payload:{},requestKey:'key',requestHash:'hash'};
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT id,role')?[device]:sql.includes('request_hash')?[{id:'saved',request_hash:'hash',payload:{secret:'private'},role:'Разработчик'}]:[]}));
        const pool={connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
        await expect(enqueueDeviceJob(pool,'id',input,readClaims)).resolves.toEqual({id:'saved'});
        expect(readClaims).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
        expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    });
});
