import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {NestFactory} from '@nestjs/core';
import type {INestApplication} from '@nestjs/common';
import {CatalogController} from '../src/catalog/catalog.controller';
import {CatalogService} from '../src/catalog/catalog.service';
import {AccessDb} from '../src/access/access-db';

const sideEffects=vi.hoisted(()=>({scan:vi.fn(),install:vi.fn(),create:vi.fn(),update:vi.fn(),get:vi.fn()}));
vi.mock('../src/catalog/local-assets',()=>({scanLocalAssets:sideEffects.scan,resolveFsRootPath:vi.fn()}));
let app:INestApplication,base:string;
const headers=(role='Главный админ')=>({'content-type':'application/json','x-bridge-actor':encodeURIComponent(JSON.stringify({email:'retired-producer@example.test',activeRole:role}))});
beforeAll(async()=>{
    const catalog=Object.assign(Object.create(CatalogService.prototype),{db:{getAiPlugin:sideEffects.get,createAiPlugin:sideEffects.create,updateAiPlugin:sideEffects.update},logger:{log:vi.fn()},onModuleInit:vi.fn(),onModuleDestroy:vi.fn()});
    Reflect.defineMetadata('design:paramtypes',[CatalogService,AccessDb],CatalogController);
    class FixtureModule{}
    app=await NestFactory.create({module:FixtureModule,controllers:[CatalogController],providers:[{provide:CatalogService,useValue:catalog},{provide:AccessDb,useValue:{claims:vi.fn()}}]},{logger:false});
    await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
beforeEach(()=>{
    vi.clearAllMocks();sideEffects.scan.mockResolvedValue({projects:[{project:'fixture',mcpServers:['unversioned-server'],mcpConfigs:{'unversioned-server':{command:['node','server.js']}},plugins:[]}]});
    sideEffects.get.mockResolvedValue(null);sideEffects.create.mockResolvedValue({id:'must-not-exist'});
});
afterAll(async()=>{await app?.close();});

describe('Retired unversioned server-folder producer — actual Nest HTTP',()=>{
    it.each([{projectName:'fixture'},{projectName:'../outside'},{}])('Returns410 before scan or native writes for %j',async body=>{
        const response=await fetch(base+'/api/ai-plugins/import-local',{method:'POST',headers:headers(),body:JSON.stringify(body)});
        expect(response.status).toBe(410);
        expect((await response.json()).message).toMatch(/упаков|ассет/i);
        for(const effect of Object.values(sideEffects))expect(effect).not.toHaveBeenCalled();
    });
    it('Keeps the main-admin guard before the retired import route',async()=>{
        const response=await fetch(base+'/api/ai-plugins/import-local',{method:'POST',headers:headers('Разработчик'),body:JSON.stringify({projectName:'fixture'})});
        expect(response.status).toBe(403);
        for(const effect of Object.values(sideEffects))expect(effect).not.toHaveBeenCalled();
    });
    it('The retired server installer and scan endpoints never call filesystem producers',async()=>{
        const install=await fetch(base+'/api/local-assets/install',{method:'POST',headers:headers(),body:JSON.stringify({kind:'mcp',name:'fixture',projectName:'fixture'})});
        expect(install.status).toBe(409);
        const scan=await fetch(base+'/api/local-assets/scan',{headers:headers()});expect(scan.status).toBe(410);
        for(const effect of Object.values(sideEffects))expect(effect).not.toHaveBeenCalled();
    });
});
