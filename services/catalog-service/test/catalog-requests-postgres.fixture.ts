import 'reflect-metadata';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {NotFoundException} from '@nestjs/common';
import type {Request} from 'express';
import {AccessDb} from '../src/access/access-db';
import type {IAccessActor} from '../src/access/access.model';
import type {CatalogService} from '../src/catalog/catalog.service';
import {CatalogRequestsService} from '../src/catalog-requests/catalog-requests.service';
import {CatalogRequestRepository} from '../src/catalog-requests/request.repository';
import type {RequestDetail} from '../src/catalog-requests/request.types';
import {ModelsService} from '../src/models/models.service';
import {connection,database,reset,main,admin,developer} from './agent-postgres.fixture';
export {connection,main,admin,developer};
export const observer={email:'observer@fixture.test',activeRole:'Наблюдатель'},stranger={email:'stranger@fixture.test',activeRole:'Разработчик'};
export const fields=(extra:Record<string,unknown>={})=>({requestKey:randomUUID(),kind:'add',assetType:'mcp',title:'Request fixture',description:'PRIVATE_REQUEST_DETAILS',...extra});
export const action=(row:RequestDetail,name:string,extra:Record<string,unknown>={})=>({requestKey:randomUUID(),expectedRevision:row.revision,action:name,...extra});
export const edit=(row:RequestDetail,extra:Record<string,unknown>={})=>({requestKey:randomUUID(),expectedRevision:row.revision,title:row.title,description:row.description,sourceUrl:row.sourceUrl,...(row.target?{target:{type:row.target.type,id:row.target.id}}:{}),...extra});
const initialSkills=()=>[
    {path:'common/request_skill',meta:{name:'Request skill',version:3}},
    {path:'common/unassigned_skill',meta:{name:'Unassigned common',version:1}},
    {path:'common/archived_skill',meta:{name:'Archived',version:1,archivedAt:'2026-01-01T00:00:00.000Z'}},
    {path:'project-prj-agents/native_skill',meta:{name:'Native project skill',version:2}},
    {path:'project-requestqa/by_name_skill',meta:{name:'Name project skill',version:4}},
    {path:'project-prj-other/foreign_skill',meta:{name:'Foreign project skill',version:1}},
];

/** Owned PostgreSQL plus a real loopback skills transport; user-provided source URLs are never dispatched. */
export async function requestsFixture(){
    const url=new URL(connection!);if(!url.port||url.port==='5432')throw Error('Explicit disposable PostgreSQL port required.');
    const fixture=await database(),pool=fixture.pool,token='request-fixture-'+randomUUID();
    let skillsStatus=200,skillsBody:unknown=initialSkills();const calls:Array<{url:string;token:string|undefined}>=[];
    const server:Server=createServer((req,res)=>{calls.push({url:req.url!,token:req.headers['x-neurocenter-internal'] as string|undefined});res.setHeader('content-type','application/json');res.statusCode=req.url==='/api/skills'?skillsStatus:404;res.end(JSON.stringify(skillsBody));});
    server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const saved={SKILLS_SERVICE_URL:process.env.SKILLS_SERVICE_URL,NEUROCENTER_INTERNAL_TOKEN:process.env.NEUROCENTER_INTERNAL_TOKEN};
    process.env.SKILLS_SERVICE_URL=origin;process.env.NEUROCENTER_INTERNAL_TOKEN=token;
    const access=Object.create(AccessDb.prototype) as AccessDb;Object.defineProperty(access,'pool',{value:pool});
    const catalog={ensureSchema:async()=>undefined,getProject:async(id:string)=>{const row=(await pool.query('SELECT id,name FROM projects WHERE id=$1 OR name=$1',[id])).rows[0];if(!row)throw new NotFoundException();return row;}} as unknown as CatalogService;
    const models=new ModelsService(catalog,access),service=new CatalogRequestsService(models);await service.pool.end();Object.defineProperties(service,{pool:{value:pool},repository:{value:new CatalogRequestRepository(pool)}});
    const request=(actor:IAccessActor)=>({headers:{'x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))}} as unknown as Request);
    return {pool,service,models,origin,token,calls,request,
        skills(status:number,body:unknown=initialSkills()){skillsStatus=status;skillsBody=body;},
        async reset(){
            await reset(pool);await pool.query('TRUNCATE catalog_requests,catalog_request_events,catalog_request_mutations,ai_plugins,model_catalog CASCADE');
            await pool.query("UPDATE projects SET name='requestqa' WHERE id='prj-agents'");
            await pool.query("INSERT INTO platform_users(email,display_name) VALUES($1,'Observer'),($2,'Stranger')",[observer.email,stranger.email]);
            await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-agents',$1,$1,'Observer','Наблюдатель'),('prj-other',$2,$2,'Stranger','Разработчик')",[observer.email,stranger.email]);
            await pool.query("INSERT INTO ai_plugins(id,name,kind) VALUES('mcp-request','Request MCP','mcp'),('plugin-request','Request plugin','plugin');INSERT INTO model_catalog(id,name,descriptor) VALUES('model-request','Request model','{}');INSERT INTO project_assets(project_id,asset_id,asset_kind) VALUES('prj-agents','mcp-request','mcp'),('prj-agents','plugin-request','plugin'),('prj-agents','common/request_skill','skill');INSERT INTO project_models(project_id,model_id,added_by) VALUES('prj-agents','model-request','fixture')");
            skillsStatus=200;skillsBody=initialSkills();calls.length=0;
        },
        async close(){
            server.closeAllConnections();await Promise.all([new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())),models.onApplicationShutdown()]);
            try{await fixture.close();}finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
        },
    };
}
export type RequestsFixture=Awaited<ReturnType<typeof requestsFixture>>;
