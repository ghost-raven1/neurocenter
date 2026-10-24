import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {requestToolImport} from '../catalog-plugins/tool-import-request.mjs';
import {TOOL_IMPORT_CLIENT_TIMEOUT_MS} from '../../services/shared/tool-import-deadline.cjs';

async function fixture(t){
    let accept,respond,received;const accepted=new Promise(resolve=>{accept=resolve;});
    const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received={method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()};respond=res;accept();});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    return {url:`http://127.0.0.1:${server.address().port}/api/tool-builds/imports`,accepted,respond:()=>respond,received:()=>received};
}

test('Import-only native HTTP keeps a valid long header wait and the exact request/response',async t=>{
    const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
    const body=JSON.stringify({requestKey:'fixture-key',asset:{id:'fixture'}}),pending=requestToolImport(f.url,{headers:{'content-type':'application/json',cookie:'qa-only'},body});
    await f.accepted;t.mock.timers.tick(400000);f.respond().writeHead(201,{'content-type':'application/json'});f.respond().end('{"catalogId":"completed"}');
    const response=await pending;assert.equal(response.status,201);assert.deepEqual(await response.json(),{catalogId:'completed'});
    assert.equal(f.received().method,'POST');assert.equal(f.received().url,'/api/tool-builds/imports');assert.equal(f.received().body,body);assert.equal(f.received().headers.cookie,'qa-only');
});
test('Import HTTP has an absolute shared deadline and closes its own socket',async t=>{
    const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
    const pending=requestToolImport(f.url,{headers:{'content-type':'application/json'},body:'{}'}).then(()=>({ok:true}),error=>({error}));
    await f.accepted;t.mock.timers.tick(TOOL_IMPORT_CLIENT_TIMEOUT_MS);const result=await pending;
    assert.equal(result.error?.name,'AbortError');assert.match(result.error?.cause?.message,/Повторите тот же запрос/);
});
test('External caller abort cancels import transport without reading operator settings',async t=>{
    const f=await fixture(t),controller=new AbortController(),pending=requestToolImport(f.url,{headers:{},body:'{}',signal:controller.signal}).then(()=>({ok:true}),error=>({error}));
    await f.accepted;controller.abort();assert.equal((await pending).error?.name,'AbortError');
});
