import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import 'reflect-metadata';
import {EventEmitter} from 'node:events';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {NestFactory} from '@nestjs/core';
import type {INestApplication} from '@nestjs/common';
import type {Request,Response} from 'express';
import {CatalogController} from '../src/catalog/catalog.controller';
import {CatalogService} from '../src/catalog/catalog.service';
import {AccessDb} from '../src/access/access-db';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';
import {buildPackage,verifyPackage} from '../src/catalog/bundle-package';
import {ProxyService} from '../../api-gateway/src/proxy/proxy.service';

const actor={email:'mock-retirement@example.test',activeRole:'Главный админ'};
const claims:IAccessClaims={email:actor.email,userRoles:[actor.activeRole],projects:[],pluginIds:[],skillPaths:[]};
const headers={'content-type':'application/json','x-bridge-actor':encodeURIComponent(JSON.stringify(actor))};
const bundle=buildPackage({id:'ai-plug-checked',name:'checked',kind:'mcp',version:3},[],'2026-10-21T00:00:00.000Z',null);
const catalog={getAiPluginPackage:vi.fn(),listAiPlugins:vi.fn()};
let app:INestApplication,base:string;

beforeAll(async()=>{
    Reflect.defineMetadata('design:paramtypes',[CatalogService,AccessDb],CatalogController);
    class FixtureModule{}
    app=await NestFactory.create({module:FixtureModule,controllers:[CatalogController],providers:[
        {provide:CatalogService,useValue:catalog},{provide:AccessDb,useValue:{claims:async()=>claims}},
    ]},{logger:false});
    await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterAll(async()=>{await app?.close();});
beforeEach(()=>{
    vi.clearAllMocks();catalog.getAiPluginPackage.mockResolvedValue(bundle);
    catalog.listAiPlugins.mockResolvedValue({items:[{id:'ai-plug-checked',name:'checked'}],page:1,size:20,total:1});
});

describe('Superseded mock producers are absent — actual Nest HTTP',()=>{
    it.each([
        ['GET','/api/skills/collections'],['GET','/api/skills'],['GET','/api/skills/sk-1'],
        ['POST','/api/skills/publish'],['POST','/api/skills/collections/col-common/head'],['GET','/api/skills/sk-1/download'],
        ['GET','/api/packages/collections'],['GET','/api/packages'],['GET','/api/packages/pk-1'],
    ])('%s %s returns404 instead of a fake successful result',async(method,route)=>{
        const response=await fetch(base+route,{method,headers,...(method==='POST'?{body:'{}'}:{})});
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({statusCode:404,error:'Not Found'});
        expect(catalog.getAiPluginPackage).not.toHaveBeenCalled();expect(catalog.listAiPlugins).not.toHaveBeenCalled();
    });
    it('The canonical versioned bundle still returns its checked manifest and exact requested version',async()=>{
        const response=await fetch(base+'/api/ai-plugins/ai-plug-checked/package?version=3',{headers});
        expect(response.status).toBe(200);
        const body=await response.json();expect(body).toEqual(bundle);expect(verifyPackage(body)).toBe(true);
        expect(catalog.getAiPluginPackage).toHaveBeenCalledExactlyOnceWith('ai-plug-checked',3);
    });
    it('The canonical catalog list remains available to its current main administrator',async()=>{
        const response=await fetch(base+'/api/ai-plugins?page=1&size=20',{headers});
        expect(response.status).toBe(200);expect((await response.json()).items).toEqual([{id:'ai-plug-checked',name:'checked'}]);
        expect(catalog.listAiPlugins).toHaveBeenCalledExactlyOnceWith(1,20,'',undefined);
    });
});

describe('Public routing keeps the canonical owner and fail-closed policy',()=>{
    it.each(['Главный админ','Админ проекта','Разработчик','Наблюдатель'])('The retired packages namespace stays denied for %s',role=>{
        for(const route of ['/api/packages','/api/packages/collections','/api/packages/pk-1']){
            for(const method of ['GET','POST','PATCH','DELETE'])expect(allowRequest({...claims,userRoles:[role]},role,{method,path:route})).toBe(false);
        }
    });
    it.each([
        ['GET','/api/skills/common/checked'],['GET','/api/skills/_package/common/checked'],['POST','/api/skills'],
    ])('%s %s is forwarded to the real skills service',async(method,route)=>{
        const request=vi.fn().mockResolvedValue({status:200,data:{path:'common/checked'},headers:{}});
        const proxy=new ProxyService({get:(key:string)=>({CATALOG_SERVICE_URL:'http://catalog.fixture',SKILLS_SERVICE_URL:'http://skills.fixture'}[key])} as never,
            {authenticate:async()=>({userId:'fixture',...actor,policies:[]})} as never,{mutation:vi.fn()} as never);
        Object.assign(proxy,{http:{get:async()=>({status:200,data:evaluateFeatureFlags(defaultFeatureFlags())}),post:async()=>({status:200,data:{allowed:true,claims}}),request}});
        const req=Object.assign(new EventEmitter(),{path:route,method,headers:{},query:{},body:method==='POST'?{path:'common',slug:'checked'}:undefined}) as Request;
        const response={status:vi.fn().mockReturnThis(),send:vi.fn(),json:vi.fn(),setHeader:vi.fn()};
        await proxy.forward(req,response as unknown as Response);
        expect(response.status).toHaveBeenCalledWith(200);
        expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({method,url:'http://skills.fixture'+route}));
    });
});
