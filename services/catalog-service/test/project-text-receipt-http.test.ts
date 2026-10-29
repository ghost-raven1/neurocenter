import 'reflect-metadata';
import {Module,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {ProjectTextController as CatalogTextController} from '../src/project-text/project-text.controller';
import {ProjectTextKnowledge} from '../src/project-text/project-text.service';
import {ProjectRagClient} from '../src/models/project-rag-client';
import {ProjectTextController as RagTextController} from '../../rag-sync-service/src/project-text/text.controller';
import {ProjectDatabases} from '../../rag-sync-service/src/rag/project-databases';

/** Missing receipts must cross both real Nest serializers as JSON null, never an empty HTTP body. */
describe('Text receipt HTTP serialization',()=>{
    const projectId='prj-http-receipt',key='12345678-1234-1234-1234-123456789abc';
    let catalog:INestApplication,rag:INestApplication,catalogUrl:string,ragUrl:string,saved:unknown=null;
    const receipt=async()=>saved;
    beforeAll(async()=>{
        Reflect.defineMetadata('design:paramtypes',[ProjectTextKnowledge],CatalogTextController);
        Reflect.defineMetadata('design:paramtypes',[ProjectDatabases],RagTextController);
        class CatalogFixture{}Module({controllers:[CatalogTextController],providers:[{provide:ProjectTextKnowledge,useValue:{receipt}}]})(CatalogFixture);
        class RagFixture{}Module({controllers:[RagTextController],providers:[{provide:ProjectDatabases,useValue:{withProject:async(_id:string,work:(db:unknown,id:string)=>unknown)=>work({text:{receipt}},projectId)}}]})(RagFixture);
        catalog=await NestFactory.create(CatalogFixture,{logger:false});await catalog.listen(0,'127.0.0.1');catalogUrl=await catalog.getUrl();
        rag=await NestFactory.create(RagFixture,{logger:false});await rag.listen(0,'127.0.0.1');ragUrl=await rag.getUrl();
    });
    afterAll(async()=>{await catalog?.close();await rag?.close();vi.unstubAllEnvs();});
    it('returns explicit JSON null from the browser receipt endpoint',async()=>{
        saved=null;const response=await fetch(`${catalogUrl}/api/projects/${projectId}/knowledge/text/requests/${key}`);
        expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');expect(await response.text()).toBe('null');
    });
    it('allows the actual Catalog RPC client to confirm that a first upload has no previous receipt',async()=>{
        saved=null;vi.stubEnv('RAG_SERVICE_URL',ragUrl);const client=new ProjectRagClient();
        await expect(client.call('text/receipt',{projectId,requestKey:key,actor:{email:'owner@http.test',activeRole:'Разработчик'}})).resolves.toBeNull();
    });
    it('preserves a committed receipt object through both serializers',async()=>{
        saved={requestKey:key,revision:1,projectId};
        const response=await fetch(`${catalogUrl}/api/projects/${projectId}/knowledge/text/requests/${key}`);
        expect(await response.json()).toEqual(saved);vi.stubEnv('RAG_SERVICE_URL',ragUrl);
        await expect(new ProjectRagClient().call('text/receipt',{projectId,requestKey:key})).resolves.toEqual(saved);
    });
});
