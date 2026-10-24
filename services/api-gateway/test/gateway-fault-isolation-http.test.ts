import 'reflect-metadata';
import {Module,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Request,Response,NextFunction} from 'express';
import {AppController} from '../src/app.controller';
import {proxyHttpFixture,reply} from './proxy-http.fixture';

let fixture:Awaited<ReturnType<typeof proxyHttpFixture>>,app:INestApplication,base:string;
beforeEach(async()=>{
 vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');fixture=await proxyHttpFixture();
 for(const[name,key]of Object.entries({catalog:'CATALOG_SERVICE_URL',skills:'SKILLS_SERVICE_URL',rag:'RAG_SERVICE_URL',auth:'AUTH_SERVICE_URL',flags:'FEATURE_FLAGS_SERVICE_URL'}))vi.stubEnv(key,fixture.origin+'/'+name);
 class HttpFixture{}Module({controllers:[AppController]})(HttpFixture);
 app=await NestFactory.create(HttpFixture,{logger:false});
 app.use((req:Request,res:Response,next:NextFunction)=>{if(req.path.startsWith('/api/'))void fixture.proxy.forward(req,res).catch(error=>res.status(error.getStatus?.()??503).json(error.getResponse?.()??{message:'Owned HTTP boundary failure.'}));else next();});
 await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterEach(async()=>{await app?.close();await fixture?.close();vi.unstubAllEnvs();});
const metadata=()=>fetch(base+'/api/projects',{headers:{cookie:'bridge_session=qa-only'}});

it.each(['rag','skills'])('starts and serves authorized Catalog traffic when %s alone is unavailable',async fault=>{
 fixture.state.handler=(_req,res,call)=>reply(res,call.kind===fault?503:200,{ok:call.kind!==fault});
 const local=await fetch(base+'/ready');expect(local.status).toBe(200);expect(await local.json()).toEqual({ok:true,checks:{gateway:'ready'}});
 expect(fixture.calls).toEqual([]);expect((await metadata()).status).toBe(200);
 const diagnostic=await fetch(base+'/ready/dependencies');expect(diagnostic.status).toBe(503);const report=await diagnostic.json();
 expect(report).toMatchObject({ok:false,checks:{[fault]:'unavailable',catalog:'ready',auth:'ready',featureFlags:'ready'}});
 expect(JSON.stringify(report)).not.toMatch(/127\.0\.0\.1|https?:|qa-proxy-internal/);
 expect((await metadata()).status).toBe(200);expect((await fetch(base+'/ready')).status).toBe(200);
});
it.each(['auth','acl'])('keeps the listener ready but refuses protected traffic when mandatory %s verification fails',async fault=>{
 if(fault==='auth')fixture.state.authStatus=503;else fixture.state.accessStatus=503;
 expect((await fetch(base+'/ready')).status).toBe(200);expect((await metadata()).status).toBe(503);expect(fixture.business()).toEqual([]);
});
