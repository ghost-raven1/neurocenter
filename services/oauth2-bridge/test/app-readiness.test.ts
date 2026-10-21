import {afterEach,expect,it,vi} from 'vitest';
import {ServiceUnavailableException} from '@nestjs/common';
import {AppController} from '../src/app.controller';

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('reports process liveness separately from confirmed catalog readiness',async()=>{
 const controller=new AppController();expect(controller.health()).toEqual({ok:true});vi.stubEnv('CATALOG_SERVICE_URL','');
 const request=vi.fn(async(_input:RequestInfo|URL,_options?:RequestInit)=>Response.json({ok:true}));vi.stubGlobal('fetch',request);
 expect(await controller.ready()).toEqual({ok:true,checks:{catalog:'ready'}});
 expect(request.mock.calls[0][0]).toBe('http://localhost:4100/ready');
 vi.stubEnv('CATALOG_SERVICE_URL','http://127.0.0.1:49999/');request.mockResolvedValueOnce(Response.json({ok:false}));
 await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);expect(request.mock.calls[1][0]).toBe('http://127.0.0.1:49999/ready');
 expect(controller.health()).toEqual({ok:true});
});
