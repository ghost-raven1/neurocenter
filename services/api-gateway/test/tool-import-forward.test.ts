import axios from 'axios';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import type {Request,Response} from 'express';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {forwardToolImport} from '../src/proxy/tool-import-forward';
import {TOOL_IMPORT_TIMEOUT_MS,TOOL_IMPORT_GATEWAY_TIMEOUT_MS,TOOL_IMPORT_CLIENT_TIMEOUT_MS,TOOL_IMPORT_CLEANUP_MARGIN_MS} from '../../shared/tool-import-deadline.cjs';

const pair=()=>({req:Object.assign(new EventEmitter(),{aborted:false}) as unknown as Request,res:Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false}) as unknown as Response});
afterEach(()=>vi.useRealTimers());
describe('Import transport keeps its bounded owner connected and propagates disconnect',()=>{
    it('keeps work, cleanup, Gateway and CLI budgets ordered below the existing 600-second edge',()=>{
        expect(TOOL_IMPORT_GATEWAY_TIMEOUT_MS-TOOL_IMPORT_TIMEOUT_MS).toBe(TOOL_IMPORT_CLEANUP_MARGIN_MS);
        expect(TOOL_IMPORT_CLEANUP_MARGIN_MS).toBeGreaterThan(30000);expect(TOOL_IMPORT_CLIENT_TIMEOUT_MS).toBeGreaterThan(TOOL_IMPORT_GATEWAY_TIMEOUT_MS);expect(TOOL_IMPORT_CLIENT_TIMEOUT_MS).toBeLessThan(600000);
    });
    it('keeps a real Axios request open beyond both the old 30-second and fetch 300-second defaults',async()=>{
        let respond!:http.ServerResponse,accept!:()=>void;const accepted=new Promise<void>(resolve=>{accept=resolve;});
        const server=http.createServer((_req,res)=>{respond=res;accept();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        const {port}=server.address() as {port:number},p=pair();vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
        const pending=forwardToolImport(axios.create({timeout:30000,proxy:false}),{url:`http://127.0.0.1:${port}/api/tool-builds/imports`,method:'POST',data:{asset:'exact envelope'}},p.req,p.res);
        try{
            await accepted;await vi.advanceTimersByTimeAsync(400000);respond.end(JSON.stringify({catalogId:'completed-import'}));
            expect((await pending)?.data).toEqual({catalogId:'completed-import'});
        }finally{p.res.emit('close');vi.useRealTimers();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
        expect(p.req.listenerCount('aborted')).toBe(0);expect(p.res.listenerCount('close')).toBe(0);
    });
    it.each(['aborted','close'])('aborts only the current upstream on %s and awaits its settlement',async event=>{
        const p=pair(),error=Error('Controlled HTTP abort'),http={request:vi.fn((config:{signal:AbortSignal})=>new Promise((_resolve,reject)=>config.signal.addEventListener('abort',()=>reject(error),{once:true})))};
        const pending=forwardToolImport(http as never,{url:'http://fixture/import',method:'POST',data:{requestKey:'unchanged'}},p.req,p.res);
        (event==='aborted'?p.req:p.res).emit(event);expect(await pending).toBeUndefined();
        expect(http.request.mock.calls[0][0]).toMatchObject({url:'http://fixture/import',method:'POST',data:{requestKey:'unchanged'},timeout:TOOL_IMPORT_GATEWAY_TIMEOUT_MS});
        expect(p.req.listenerCount('aborted')).toBe(0);expect(p.res.listenerCount('close')).toBe(0);
    });
});
