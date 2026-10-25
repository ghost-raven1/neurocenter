import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {test} from 'node:test';
import {healthReader} from '../dev-mcp/health.mjs';
import {devServices,serviceDetailsFlag} from '../workspace/dev-service-health.mjs';

/** Every HTTP fixture owns an ephemeral loopback port and closes its own sockets. */
async function localServer(t,handler){
    const server=http.createServer(handler);
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    return server.address().port;
}

test('health 200 does not claim dependency readiness when ready returns 503',{timeout:10000},async t=>{
    const routes=[],port=await localServer(t,(request,response)=>{
        routes.push(request.url);response.writeHead(request.url==='/ready'?503:200).end(JSON.stringify({ok:request.url!=='/ready',private:'DO_NOT_EMIT_SECRET'}));
    });
    const value=await healthReader([{name:'catalog',port,path:'/health',readinessPath:'/ready'}])();
    assert.equal(value.services[0].ready,false);
    assert.equal(value.services[0].liveness.ok,true);
    assert.equal(value.services[0].readiness.statusCode,503);
    assert.deepEqual(routes.sort(),['/health','/ready']);
    assert.doesNotMatch(JSON.stringify(value),/DO_NOT_EMIT_SECRET/);
});

test('a foreign HTTP listener does not become owned because health is successful',{timeout:10000},async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'dev-health-foreign-'));
    await fs.mkdir(path.join(root,'services/catalog-service'),{recursive:true});
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const port=await localServer(t,(_request,response)=>response.end('{"ok":true}'));
    const value=await healthReader([{name:'catalog',port,path:'/health'}],{root})();
    assert.equal(value.services[0].ownership.state,'foreign');
});

test('passive diagnostics skip both direct and transitive writable readiness endpoints',{timeout:10000},async t=>{
    const routes=[],port=await localServer(t,(request,response)=>{routes.push(request.url);response.end('{"ok":true}');});
    const value=await healthReader(['skills','gateway'].map(name=>({name,port,path:'/health'})))();
    assert.deepEqual(routes,['/health','/health']);
    for(const result of value.services){
        assert.equal(result.liveness.ok,true);assert.equal(result.ready,null);
        assert.equal(result.readiness.state,'skipped');assert.equal(result.readiness.reason,'side-effectful-endpoint');
    }
    assert.equal(devServices.find(item=>item.name==='flags').path,'/health');
});

test('feature off keeps liveness and disables dependency and process probes',{timeout:10000},async t=>{
    const routes=[],port=await localServer(t,(request,response)=>{routes.push(request.url);response.end('{"ok":true}');});
    const value=await healthReader([{name:'catalog',port,path:'/health'}],{detailsEnabled:false,inspectOwnership:()=>assert.fail('No inspection when disabled')})();
    const result=value.services[0];assert.deepEqual(routes,['/health']);
    assert.equal(result.liveness.ok,true);assert.equal(result.ready,null);assert.equal(result.readiness.reason,'disabled');assert.equal(result.ownership.state,'disabled');
    assert.equal(serviceDetailsFlag({}),true);assert.equal(serviceDetailsFlag({NEUROCENTER_DEV_MCP_SERVICE_DETAILS:'0'}),false);
    assert.throws(()=>serviceDetailsFlag({NEUROCENTER_DEV_MCP_SERVICE_DETAILS:'false'}),/0 or 1/);
});

test('readiness is bounded at 2500ms and cancellation closes both owned probe sockets',{timeout:10000},async t=>{
    const sockets=new Set(),requests=[];
    let entered;const both=new Promise(resolve=>{entered=resolve;});
    const port=await localServer(t,(request,response)=>{
        requests.push(request.url);sockets.add(request.socket);request.socket.once('close',()=>sockets.delete(request.socket));
        if(requests.length===2)entered();
        if(request.url==='/health')response.end('{"ok":true}');
    });
    const controller=new AbortController(),pending=healthReader([{name:'catalog',port,path:'/health'}])(controller.signal);
    await both;controller.abort();const result=(await pending).services[0];
    assert.equal(result.readiness.state,'cancelled');
    const until=Date.now()+1000;while(sockets.size&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(sockets.size,0);
    const started=Date.now(),timeout=(await healthReader([{name:'catalog',port,path:'/health'}])()).services[0];
    assert.equal(timeout.readiness.state,'timeout');assert.ok(Date.now()-started<3500);assert.equal(timeout.ready,false);
});

test('frontend compile result is visibly partial and never a backend dependency result',{timeout:10000},async t=>{
    const port=await localServer(t,(_request,response)=>response.writeHead(200,{'content-type':'text/css'}).end('.ant {color:red}'));
    const result=(await healthReader([{name:'frontend',port,path:'/compile.css'}])()).services[0];
    assert.equal(result.ready,true);assert.equal(result.compilation.ok,true);assert.equal(result.compilation.partialProbe,true);
    assert.equal(result.liveness.state,'skipped');assert.equal(result.readiness.state,'skipped');
});
