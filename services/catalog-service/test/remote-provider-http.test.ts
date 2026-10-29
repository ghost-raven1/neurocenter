import 'reflect-metadata';
import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {afterEach,describe,expect,it} from 'vitest';
import {RemoteProviderAccessController} from '../src/remote-providers/remote-provider.controller';
import {RemoteProviderAccessService} from '../src/remote-providers/remote-provider.service';
const key='00000000-0000-0000-0000-000000000001';
let value:unknown=null;
class HttpFixture{}
Module({controllers:[RemoteProviderAccessController],providers:[{provide:RemoteProviderAccessService,useValue:{receipt:async()=>value}}]})(HttpFixture);
Reflect.defineMetadata('design:paramtypes',[RemoteProviderAccessService],RemoteProviderAccessController);
let app:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
afterEach(async()=>{await app?.close();app=undefined;});
describe('literal personal receipt HTTP boundary',()=>{
    it.each([null,{requestKey:key,hasKey:true}])('serializes %j as JSON through a real Nest server',async receipt=>{
        value=receipt;app=await NestFactory.create(HttpFixture,{logger:false});await app.listen(0,'127.0.0.1');
        const response=await fetch((await app.getUrl())+'/api/models/model-personal/my-access/requests/'+key);
        expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');expect(await response.json()).toEqual(receipt);
    });
});
