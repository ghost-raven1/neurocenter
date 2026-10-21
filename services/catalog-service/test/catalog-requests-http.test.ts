import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Module,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {IAccessActor} from '../src/access/access.model';
import {CatalogRequestsController} from '../src/catalog-requests/catalog-requests.controller';
import {CatalogRequestsService} from '../src/catalog-requests/catalog-requests.service';
import {connection,requestsFixture,type RequestsFixture,fields,action,edit,main,admin,developer,stranger} from './catalog-requests-postgres.fixture';

/** Catalog's internal HTTP boundary is real; browser SSO/Gateway and global feature guard are covered separately. */
describe.skipIf(!connection)('Catalog request HTTP → actual controller/service/PostgreSQL',()=>{
    let f:RequestsFixture,app:INestApplication,url:string;
    const headers=(actor:IAccessActor)=>({'content-type':'application/json','x-neurocenter-internal':f.token,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))});
    const http=async(actor:IAccessActor,path:string,method='GET',body?:unknown)=>{
        const response=await fetch(url+path,{method,headers:headers(actor),...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};
    };
    const base='/api/catalog-requests';
    beforeAll(async()=>{
        f=await requestsFixture();
        const delegate={list:f.service.list.bind(f.service),get:f.service.get.bind(f.service),targets:f.service.targets.bind(f.service),create:f.service.create.bind(f.service),edit:f.service.edit.bind(f.service),action:f.service.action.bind(f.service)};
        Reflect.defineMetadata('design:paramtypes',[CatalogRequestsService],CatalogRequestsController);
        class HttpFixture{}Module({controllers:[CatalogRequestsController],providers:[{provide:CatalogRequestsService,useValue:delegate}]})(HttpFixture);
        app=await NestFactory.create(HttpFixture,{logger:false});await app.listen(0,'127.0.0.1');url=await app.getUrl();
    });
    beforeEach(async()=>f.reset());afterAll(async()=>{await app?.close();await f?.close();});
    it('returns real scoped details, pagination and available target results from their distinct routes',async()=>{
        const created=await http(developer,base,'POST',fields({projectId:'prj-agents'}));expect(created.status).toBe(201);expect(created.value).toMatchObject({createdBy:developer.email,status:'submitted',history:[{action:'create'}]});
        expect((await http(developer,base+'/'+created.value.id)).value).toEqual(created.value);
        expect((await http(admin,base+'?scope=all&projectId=prj-agents&page=1&size=1')).value).toMatchObject({items:[{id:created.value.id}],total:1,page:1,size:1});
        const targets=await http(admin,base+'/targets?assetType=mcp&projectId=prj-agents&q=Request&limit=1');expect(targets.status).toBe(200);expect(targets.value).toEqual({items:[{type:'mcp',id:'mcp-request',name:'Request MCP',version:1,available:true}]});
    });
    it('PATCH edits through owner CAS and rejects stale drafts without altering the saved data',async()=>{
        const row=(await http(developer,base,'POST',fields({projectId:'prj-agents'}))).value,input=edit(row,{title:'Saved title'});
        const saved=await http(developer,base+'/'+row.id,'PATCH',input);expect(saved.status).toBe(200);expect(saved.value).toMatchObject({revision:2,title:'Saved title'});
        expect((await http(developer,base+'/'+row.id,'PATCH',{...edit(row),title:'Old tab draft'})).status).toBe(409);
        expect((await http(developer,base+'/'+row.id)).value).toEqual(saved.value);
        expect((await http(admin,base+'/'+row.id,'PATCH',edit(saved.value))).status).toBe(403);
    });
    it('POST actions need a current reviewer and explicit result target before a completed response is returned',async()=>{
        let row=(await http(developer,base,'POST',fields({projectId:'prj-agents'}))).value;
        expect((await http(developer,base+'/'+row.id+'/actions','POST',action(row,'start'))).status).toBe(403);
        const started=await http(admin,base+'/'+row.id+'/actions','POST',action(row,'start'));expect(started.status).toBe(201);row=started.value;
        expect((await http(admin,base+'/'+row.id+'/actions','POST',action(row,'complete',{comment:'Missing result'}))).status).toBe(400);
        const done=await http(admin,base+'/'+row.id+'/actions','POST',action(row,'complete',{comment:'Verified project connection',target:{type:'mcp',id:'mcp-request'}}));expect(done.status).toBe(201);expect(done.value).toMatchObject({status:'completed',revision:3,target:{type:'mcp',id:'mcp-request',version:1}});
        expect((await http(main,base+'/'+row.id)).value.history.map((entry:{action:string})=>entry.action)).toEqual(['create','start','complete']);
    });
    it('an unrelated actor sees no detail and no list records even with the correct UUID and project filter',async()=>{
        const row=(await http(developer,base,'POST',fields({projectId:'prj-agents'}))).value;
        expect((await http(stranger,base+'/'+row.id)).status).toBe(404);expect((await http(stranger,base+'?scope=all&projectId=prj-agents')).value.items).toEqual([]);
        expect((await http(stranger,base+'/targets?assetType=mcp&projectId=prj-agents')).status).toBe(403);
    });
    it.each(['size=101','page=NaN','cursor=unsupported','status=approved'])('does not ignore malformed or unsupported list query %s',async query=>{
        expect((await http(main,base+'?'+query)).status).toBe(400);expect((await f.pool.query('SELECT * FROM catalog_requests')).rows).toEqual([]);
    });
    it('checks malformed IDs, source ownership fields and JSON at the actual HTTP boundary',async()=>{
        expect((await http(main,base+'/not-a-uuid')).status).toBe(400);
        expect((await http(developer,base,'POST',fields({createdBy:main.email})))).toMatchObject({status:400});
        expect((await fetch(url+base,{method:'POST',headers:headers(developer),body:'{'})).status).toBe(400);
        const forged=await fetch(url+base,{method:'POST',headers:{...headers(main),'x-neurocenter-internal':'wrong'},body:JSON.stringify(fields())});expect(forged.status).toBe(403);expect((await f.pool.query('SELECT * FROM catalog_requests')).rows).toEqual([]);
    });
    it('a role revoked between HTTP requests cannot replay an old mutation or read the private record',async()=>{
        const input=fields({projectId:'prj-agents'}),row=(await http(developer,base,'POST',input)).value;
        await f.pool.query('DELETE FROM project_members WHERE principal_name=$1',[developer.email]);
        expect((await http(developer,base,'POST',input)).status).toBe(403);expect((await http(developer,base+'/'+row.id)).status).toBe(403);
        expect((await f.pool.query('SELECT revision FROM catalog_requests WHERE id=$1',[row.id])).rows[0].revision).toBe(1);
    });
});
