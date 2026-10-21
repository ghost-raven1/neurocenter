import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import type {Server} from 'socket.io';
import {LiveService} from '../src/live/live.service';
import {LiveController} from '../src/live/live.controller';

let live:LiveService;const events:Array<{room?:string;event:string;data?:unknown}>=[];
const close=vi.fn((callback:()=>void)=>callback());
const io={emit:(event:string,data?:unknown)=>events.push({event,data}),
    to:(room:string)=>({emit:(event:string,data?:unknown)=>events.push({room,event,data})}),close};
beforeEach(()=>{live=new LiveService();events.length=0;vi.clearAllMocks();});
afterEach(()=>vi.unstubAllEnvs());
function attach(){live.attach(io as unknown as Server);}

describe('Live invalidation without private payloads',()=>{
    it('allows an unattached service to shut down without retaining a transport',async()=>{
        live.sections(['projects']);live.bridge('owner');live.wake('device');await live.onModuleDestroy();expect(events).toEqual([]);expect(close).not.toHaveBeenCalled();
    });
    it('awaits closure of the attached transport',async()=>{attach();await live.onModuleDestroy();expect(close).toHaveBeenCalledOnce();});
    it.each([
        ['/api/catalog-requests/owned',['requests','audit'],false],
        ['/api/feature-flags/agents',['maintenance','catalog','knowledge','projects','audit'],false],
        ['/api/device-install-plans/id',['catalog','audit'],false],
        ['/api/projects/id/members',['access','projects','catalog','audit'],true],
        ['/api/platform/users/id',['access','projects','catalog','audit'],true],
        ['/api/projects/id',['projects','catalog','knowledge','maintenance','operations','audit'],false],
        ['/api/ai-plugins/id',['catalog','projects','audit'],false],
        ['/api/models/id',['catalog','projects','operations','audit'],false],
        ['/api/agents/id',['catalog','projects','operations','audit'],false],
        ['/api/skills/id',['catalog','projects','audit'],false],
        ['/api/rag/id',['knowledge','projects','operations','audit'],false],
        ['/api/maintenance/policy',['maintenance','projects','audit','operations'],false],
        ['/api/operations/id',['operations','audit','projects'],false],
    ])('invalidates sections for %s without forwarding mutation data', (path,sections,auth)=>{
        attach();live.mutation(path,'owner@example.test',{prompt:'PRIVATE-PROMPT',apiKey:'PRIVATE-KEY',baseUrl:'https://private.invalid'},'POST');
        expect(events.find(item=>item.event==='section:changed')?.data).toEqual({sections,at:expect.stringMatching(/^\d{4}-\d\d-\d\dT/)});
        expect(events.some(item=>item.event==='auth:changed')).toBe(auth);
        expect(JSON.stringify(events)).not.toMatch(/PRIVATE|private\.invalid|owner@example/);
    });
    it.each(['/api/projects/project-id','/api/projects/project-id/'])('refreshes roles only for an exact project deletion: %s',path=>{
        attach();live.mutation(path,'owner',undefined,'DELETE');expect(events.some(item=>item.event==='auth:changed')).toBe(true);
        expect((events[0].data as {sections:string[]}).sections).toContain('access');
    });
    it('keeps a nested deletion inside normal project invalidation',()=>{attach();live.mutation('/api/projects/id/assets/id','owner',undefined,'DELETE');expect(events.some(item=>item.event==='auth:changed')).toBe(false);});
    it.each(['/api/devices/id','/api/device-pairs/id'])('sends device invalidation only to the owner room: %s',path=>{
        attach();live.mutation(path,'owner@example.test',{deviceId:'not-forwarded'});
        expect(events).toEqual([{room:'user:owner@example.test',event:'bridge:changed',data:{deviceId:undefined,jobId:undefined}}]);
    });
    it.each([undefined,{deviceId:'device-owned',id:'job-owned',prompt:'PRIVATE'}])('wakes only a specified job device: %j',data=>{
        attach();live.mutation('/api/device-jobs','owner@example.test',data);
        expect(events[0]).toEqual({room:'user:owner@example.test',event:'bridge:changed',data:{deviceId:data?.deviceId,jobId:data?.id}});
        expect(events.filter(item=>item.event==='bridge:work')).toEqual(data?[{room:'device:device-owned',event:'bridge:work',data:undefined}]:[]);
        expect(JSON.stringify(events)).not.toContain('PRIVATE');
    });
    it('wakes the exact agent configuration job after the server-created response',()=>{
        attach();live.mutation('/api/projects/id/agents/connect/','owner',{kind:'configure-project-agents',deviceId:'device',id:'job',prompt:'PRIVATE'},'POST');
        expect(events.slice(0,2)).toEqual([{room:'user:owner',event:'bridge:changed',data:{deviceId:'device',jobId:'job'}},{room:'device:device',event:'bridge:work',data:undefined}]);
        expect(JSON.stringify(events)).not.toContain('PRIVATE');
    });
    it.each([
        [{kind:'other',deviceId:'device',id:'job'},'POST'],
        [{kind:'configure-project-agents',deviceId:'',id:'job'},'POST'],
        [{kind:'configure-project-agents',deviceId:'device',id:''},'POST'],
        [{kind:'configure-project-agents',deviceId:'device'},'POST'],
        [{kind:'configure-project-agents',deviceId:'device',id:'job'},'PATCH'],
    ])('does not infer device work from an unconfirmed configuration response: %j', (data,method)=>{
        attach();live.mutation('/api/projects/id/agents/connect','owner',data,method);expect(events.some(item=>item.room)).toBe(false);
    });
    it('ignores an unrelated mutation path',()=>{attach();live.mutation('/api/catalog-requests-suffix','owner',{secret:'PRIVATE'});expect(events).toEqual([]);});
});

describe('Internal event publication',()=>{
    it.each([undefined,'short','b'.repeat(64)])('requires the exact server credential: %s',token=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','a'.repeat(64));attach();
        expect(()=>new LiveController(live).publish(token as string,{sections:['projects']})).toThrow(ForbiddenException);expect(events).toEqual([]);
    });
    it('fails closed when the internal channel is not configured',()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');expect(()=>new LiveController(live).publish('',{})).toThrow(ForbiddenException);
    });
    it('publishes only approved section names, never caller-supplied objects',()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','a'.repeat(64));attach();const controller=new LiveController(live);
        expect(controller.publish('a'.repeat(64),{sections:['projects','catalog','knowledge','access','maintenance','audit','operations','PRIVATE']})).toEqual({ok:true});
        expect((events[0].data as {sections:string[]}).sections).toEqual(['projects','catalog','knowledge','access','maintenance','audit','operations']);
        expect(JSON.stringify(events)).not.toContain('PRIVATE');controller.publish('a'.repeat(64),{});expect((events[1].data as {sections:string[]}).sections).toEqual([]);
    });
});
