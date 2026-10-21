import 'reflect-metadata';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ForbiddenException,NotFoundException} from '@nestjs/common';
import type {Request} from 'express';
import type {Pool} from 'pg';
import {AccessDb} from '../src/access/access-db';
import {AgentsService} from '../src/agents/agents.service';
import {AgentRepository} from '../src/agents/agent.repository';
import {ProjectAgentRepository} from '../src/agents/project-agent.repository';
import {ModelsService} from '../src/models/models.service';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {DeviceJobs} from '../src/devices/device-jobs';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {connection,database,reset,main,admin,developer,definition} from './agent-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));

describe.skipIf(!connection)('Agent service lifecycle — fresh actor and committed PostgreSQL state',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,service:AgentsService,models:ModelsService;
    const ready=vi.fn(async()=>undefined),jobs={create:vi.fn(async()=>({id:randomUUID(),state:'queued'}))};
    const request=(actor=main)=>({headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))}} as Request);
    const create=()=>service.cards.create(main,{requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition});
    const assign=async()=>{const card=await create();await service.projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:0,agentId:card.id,version:1,manifest:card.manifest});return card;};
    const revision=()=>service.projects.currentRevision('prj-agents');
    const events=()=>vi.mocked(fetch).mock.calls;
    beforeAll(async()=>{
        if(new URL(connection!).port==='5432')throw Error('Use a caller-owned disposable PostgreSQL port.');
        fixture=await database();pool=fixture.pool;
        const access=new AccessDb();await (access as unknown as {pool:Pool}).pool.end();Object.defineProperty(access,'pool',{value:pool});
        const catalog={ensureSchema:ready,getProject:async(id:string)=>{const row=(await pool.query('SELECT id,name FROM projects WHERE id=$1 OR name=$1',[id])).rows[0];if(!row)throw new NotFoundException();return row;}} as unknown as CatalogService;
        models=new ModelsService(catalog,access);service=new AgentsService(models,jobs as unknown as DeviceJobs);
        await service.pool.end();Object.defineProperties(service,{pool:{value:pool},cards:{value:new AgentRepository(pool)},projects:{value:new ProjectAgentRepository(pool)}});
    });
    beforeEach(async()=>{
        await reset(pool);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','owned-agent-service-fixture');ready.mockClear();jobs.create.mockClear();
        vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,body:{cancel:vi.fn(async()=>undefined)}}));
    });
    afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
    afterAll(async()=>{await models?.onApplicationShutdown();await fixture?.close();vi.unstubAllEnvs();});

    it('waits for catalog readiness and closes its own idle pool at shutdown',async()=>{
        let release!:()=>void;ready.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
        let settled=false;const starting=service.onModuleInit().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();await starting;
        const independent=new AgentsService(models,jobs as unknown as DeviceJobs);await independent.onApplicationShutdown();expect(independent.pool.ended).toBe(true);
    });
    it('common administrators see heads while developers see only assigned immutable versions',async()=>{
        const card=await assign();await service.cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:1,definition:{...definition,prompt:'NEW_COMMON_PRIVATE_PROMPT'}});
        await service.cards.create(main,{requestKey:randomUUID(),slug:'nc-unassigned',name:'Недоступный',definition});
        expect((await service.list(request(main))).items).toHaveLength(2);
        expect((await service.list(request(admin),'prj-agents')).items).toHaveLength(2);
        const own=await service.list(request(developer));expect(own.items).toHaveLength(1);expect(own.items[0]).toMatchObject({id:card.id,version:1,definition:{prompt:definition.prompt}});
        expect(JSON.stringify(own)).not.toContain('NEW_COMMON_PRIVATE_PROMPT');expect((await service.get(request(developer),card.id)).version).toBe(1);
    });
    it('project reads retain archive state and pinned prompt, then stop exposing removed assignments',async()=>{
        const card=await assign();await pool.query('UPDATE agent_catalog SET archived_at=now() WHERE id=$1',[card.id]);
        const view=await service.list(request(developer),'prj-agents');expect(view.items[0]).toMatchObject({id:card.id,version:1,archivedAt:expect.any(String)});
        expect(view.assignments[0].effective.prompt).toBe(definition.prompt);
        await service.remove(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1});
        expect((await service.list(request(developer),'prj-agents')).items).toEqual([]);
        await expect(service.get(request(developer),card.id)).rejects.toMatchObject({status:403});
    });
    it('rechecks account and project grants on reads without requiring a new login',async()=>{
        await assign();const req=request(developer);expect((await service.list(req)).items).toHaveLength(1);
        await pool.query('DELETE FROM project_members WHERE principal_name=$1',[developer.email]);await expect(service.list(req)).rejects.toMatchObject({status:403});
        await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[main.email]);await expect(service.list(request(main))).rejects.toMatchObject({status:403});
    });
    it('rejects another project and a forged actor before reading private agent data',async()=>{
        await assign();await expect(service.list(request(developer),'prj-other')).rejects.toMatchObject({status:403});
        const forged=request(main);forged.headers['x-neurocenter-internal']='wrong-token';await expect(service.list(forged)).rejects.toMatchObject({status:403});
        expect(events()).toHaveLength(0);
    });
    it('publishes change events only after common and project mutations commit',async()=>{
        const seen:string[]=[];vi.mocked(fetch).mockImplementation(async()=>{seen.push((await pool.query('SELECT action FROM security_events ORDER BY created_at DESC,event_id DESC LIMIT 1')).rows[0].action);return {body:{cancel:async()=>undefined}} as Response;});
        const card=await service.create(request(main),{requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition});
        const next=await service.update(request(main),card.id,{requestKey:randomUUID(),expectedVersion:1,name:'Новое имя'});
        await service.assign(request(admin),'prj-agents',{requestKey:randomUUID(),expectedRevision:0,agentId:card.id,version:next.version,manifest:next.manifest});
        await service.configure(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true});
        await service.remove(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:2});
        expect(seen).toEqual(['agent.create','agent.update','project.agent.assign','project.agent.update','project.agent.remove']);expect(await revision()).toBe(3);
    });
    it('retains committed settings when the online events channel is unavailable',async()=>{
        const card=await assign();vi.mocked(fetch).mockRejectedValue(new Error('events offline'));
        await service.configure(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true});
        expect(await revision()).toBe(2);expect((await service.projects.snapshot('prj-agents')).agents[0].enabled).toBe(true);
    });
    it('does not publish or partially save a failed mutation',async()=>{
        const card=await assign();await expect(service.configure(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:0,enabled:true})).rejects.toMatchObject({status:409});
        await expect(service.update(request(developer),card.id,{requestKey:randomUUID(),expectedVersion:1,name:'Forged edit'})).rejects.toMatchObject({status:403});
        expect(events()).toHaveLength(0);expect(await revision()).toBe(1);expect((await service.cards.get(card.id)).version).toBe(1);
    });
    it('off prevents new work but allows exact disable and removal recovery',async()=>{
        const card=await assign();await service.projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true});
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('agents off'));
        await expect(service.configure(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:2,enabled:true})).rejects.toMatchObject({status:403});
        const disabled=await service.configure(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:2,enabled:false});expect(disabled.assignment.enabled).toBe(false);
        const removed=await service.remove(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:3});expect(removed.assignment.removed).toBe(true);
        expect(await revision()).toBe(4);expect(events()).toHaveLength(2);
    });
    it.each([{overrides:{prompt:'hidden write'}},{expectedVersion:1},{enabled:0}])('an off capability cannot be bypassed by a disabling-looking body %#',async extra=>{
        const card=await assign();vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('agents off'));
        await expect(service.configure(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:false,...extra})).rejects.toMatchObject({status:403});
        expect(await revision()).toBe(1);expect(events()).toHaveLength(0);
    });
    it('revocation after project resolution is caught by the transaction before a recovery write',async()=>{
        const card=await assign(),resolve=models.resolveProject.bind(models);
        vi.spyOn(models,'resolveProject').mockImplementationOnce(async(...args)=>{const project=await resolve(...args);await pool.query('DELETE FROM project_members WHERE principal_name=$1',[admin.email]);return project;});
        await expect(service.remove(request(admin),'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1})).rejects.toMatchObject({status:403});
        expect(await revision()).toBe(1);expect((await service.projects.assignments('prj-agents'))[0].removed).toBe(false);expect(events()).toHaveLength(0);
    });
    it('connect forwards only pinned desired-state identity and never accepts browser prompt bytes',async()=>{
        const input={requestKey:randomUUID(),expectedRevision:7,deviceId:randomUUID(),expectedBindingId:'a'.repeat(64),expectedInstanceId:randomUUID()};
        expect(await service.connect(request(admin),'prj-agents',input)).toMatchObject({state:'queued',desiredRevision:7});
        expect(jobs.create).toHaveBeenCalledWith(expect.objectContaining(admin),{kind:'configure-project-agents',projectId:'prj-agents',requestKey:input.requestKey,deviceId:input.deviceId,expectedAgentsRevision:7,expectedBindingId:input.expectedBindingId,expectedInstanceId:input.expectedInstanceId});
        await expect(service.connect(request(admin),'prj-agents',{...input,prompt:'browser bytes'})).rejects.toMatchObject({status:400});expect(jobs.create).toHaveBeenCalledTimes(1);
    });
});
