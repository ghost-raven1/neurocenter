import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import {after,before,describe,it} from 'node:test';
import {startGatewayAppRuntime} from './gateway-app-runtime.fixture.mjs';

/** Source AppModule acceptance: genuine Nest DI and transports, isolated synthetic upstream services. */
describe('Canonical Gateway application runtime',{concurrency:false,timeout:60000},()=>{
    let f;
    before(async()=>{f=await startGatewayAppRuntime();});
    after(async()=>{await f?.close();});

    it('boots real providers and serves health/local readiness without consulting any remote subsystem',async()=>{
        assert.equal(process.env.NODE_ENV,'production');assert.equal(process.cwd(),f.temporary);
        assert.equal(f.app.get('MCP_HOST').constructor.name,'McpHostService');
        assert.deepEqual(f.hostTimers(),[{cleared:false,referenced:false},{cleared:false,referenced:false}]);
        const before=f.snapshot();
        assert.deepEqual(await f.request('/health'),{ok:true});
        assert.deepEqual(await f.request('/ready'),{ok:true,checks:{gateway:'ready'}});
        assert.deepEqual(f.snapshot(),before);
    });

    it('rejects absent and invalid internal tokens before any peer HTTP or child process action',async()=>{
        const before=f.snapshot();
        for(const route of ['execute','close'])for(const internal of [undefined,'bad-token']){
            await f.request('/internal/system-role-mcp/'+route,{method:'POST',body:{},internal,status:403,authenticated:false});
        }
        assert.deepEqual(f.snapshot(),before);
    });

    it('rejects malformed bodies with a valid internal token before feature checks, package reads or tool dispatch',async()=>{
        const before=f.snapshot();
        for(const body of [{},{callId:'not-a-uuid'},{callId:'00000000-0000-0000-0000-000000000000',extra:true},[]]){
            await f.request('/internal/system-role-mcp/execute',{method:'POST',body,internal:'valid',status:403});
        }
        for(const body of [{},{sessionId:'not-a-uuid',package:{}},{sessionId:'00000000-0000-0000-0000-000000000000'}]){
            await f.request('/internal/system-role-mcp/close',{method:'POST',body,internal:'valid',status:403});
        }
        assert.deepEqual(f.snapshot(),before);
    });

    it('routes an authenticated projects read through the actual auth/access/proxy chain and replaces forged identity',async()=>{
        const calls=f.state.calls.length,projects=f.state.projects.length;
        assert.deepEqual(await f.request('/api/projects?q=owned',{headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:'forged@runtime.test',activeRole:'Главный админ'}))}}),[f.project]);
        assert.deepEqual(f.state.calls.slice(calls),[
            {peer:'auth',method:'GET',path:'/auth/me'},
            {peer:'catalog',method:'POST',path:'/internal/access/authorize'},
            {peer:'catalog',method:'GET',path:'/api/projects'},
        ]);
        assert.deepEqual(f.state.projects.slice(projects),[{trusted:true,actor:{email:f.email,activeRole:f.role},query:'?q=owned'}]);
        const authorization=f.state.authorizations.at(-1);
        assert.equal(authorization.trusted,true);assert.equal(authorization.body.email,f.email);
        assert.equal(authorization.body.activeRole,f.role);assert.equal(authorization.body.path,'/api/projects');
    });

    it('uses fresh authentication and access decisions without forwarding a denied catalog request',async()=>{
        const projects=f.state.projects.length,decisions=f.state.authorizations.length;
        f.state.authStatus=401;
        try{await f.request('/api/projects',{status:401});assert.equal(f.state.authorizations.length,decisions);}
        finally{f.state.authStatus=200;}
        f.state.accessAllowed=false;
        try{await f.request('/api/projects',{status:403});}
        finally{f.state.accessAllowed=true;}
        assert.equal(f.state.projects.length,projects);
        assert.deepEqual(await f.request('/api/projects'),[f.project]);
    });

    it('reports refused RAG and degraded skills separately while health, local readiness and catalog reads remain usable',async()=>{
        const healthy=await f.request('/ready/dependencies');assert.equal(healthy.ok,true);
        f.state.rag='refuse';f.state.skills='unavailable';
        try{
            const dependencies=await f.request('/ready/dependencies',{status:503});
            assert.equal(dependencies.ok,false);
            assert.deepEqual(dependencies.checks,{catalog:'ready',skills:'unavailable',rag:'unavailable',auth:'ready',featureFlags:'ready'});
            await f.request('/api/rag/projects',{status:502});await f.request('/api/skills',{status:503});
            assert.deepEqual(await f.request('/health'),{ok:true});
            assert.deepEqual(await f.request('/ready'),{ok:true,checks:{gateway:'ready'}});
            assert.deepEqual(await f.request('/api/projects'),[f.project]);
        }finally{f.state.rag='ready';f.state.skills='ready';}
        assert.equal((await f.request('/ready/dependencies')).ok,true);
    });

    it('opens a genuine Socket.IO Engine transport that the actual LiveService must dispose',async()=>{
        const packet=await f.request('/socket.io/?EIO=4&transport=polling');
        assert.equal(packet[0],'0');assert.equal(typeof JSON.parse(packet.slice(1)).sid,'string');
        assert.equal(f.io.engine.clientsCount,1);
        // main.ts socket authentication, rooms and browser-origin policy are outside this AppModule fixture.
    });

    it('closes HTTP, the real Socket.IO client and both unrefed MCP intervals without relying on child exit',async()=>{
        assert.equal(f.state.unknownDependencies,0);assert.equal(f.state.blockedFetches,0);
        assert.equal(f.state.blockedHttp,0);assert.equal(f.state.blockedProcesses,0);
        const cleanup=await f.close();
        assert.deepEqual(cleanup,{applicationClosed:true,httpListeningAfterApplicationClose:false,httpListening:false,socketClients:0,mcpTimersCreated:2,mcpTimersCleared:2,peersListening:0,failures:[]});
        await assert.rejects(f.request('/health'));
    });

    it('reports a controlled close acknowledgement failure and restores all process boundaries in finally',async t=>{
        const previous={fetch:globalThis.fetch,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,
            httpRequest:http.request,httpGet:http.get,httpsRequest:https.request,httpsGet:https.get,
            processMethods:Object.fromEntries(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'].map(key=>[key,childProcess[key]])),
            cwd:process.cwd(),environment:{...process.env}};
        let reallyClosed=false;
        const fixture=await startGatewayAppRuntime({afterApplicationClose:()=>{reallyClosed=true;throw new Error('Controlled Gateway post-close acknowledgement failure');}});
        await assert.rejects(fixture.close(),error=>{
            assert.ok(error instanceof AggregateError);
            assert.ok(error.errors.some(cause=>cause?.message==='Controlled Gateway post-close acknowledgement failure'));return true;
        });
        assert.equal(reallyClosed,true);assert.equal(fixture.state.cleanup.applicationClosed,true);
        assert.equal(fixture.state.cleanup.httpListening,false);assert.equal(fixture.state.cleanup.socketClients,0);
        assert.equal(fixture.state.cleanup.mcpTimersCleared,2);assert.equal(fixture.state.cleanup.peersListening,0);
        assert.deepEqual(fixture.state.cleanup.failures,['gateway application']);
        assert.equal(globalThis.fetch,previous.fetch);assert.equal(globalThis.setInterval,previous.setInterval);assert.equal(globalThis.clearInterval,previous.clearInterval);
        assert.equal(http.request,previous.httpRequest);assert.equal(http.get,previous.httpGet);
        assert.equal(https.request,previous.httpsRequest);assert.equal(https.get,previous.httpsGet);
        for(const[key,native]of Object.entries(previous.processMethods))assert.equal(childProcess[key],native);
        assert.equal(process.cwd(),previous.cwd);
        const entries=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
        assert.equal(entries(process.env)===entries(previous.environment),true,'The process environment was not restored');
        const diagnostic=JSON.parse(await fs.readFile(fixture.state.cleanup.diagnosticPath,'utf8'));
        assert.deepEqual(diagnostic.failures,['gateway application']);assert.equal(diagnostic.mcpTimersCleared,2);
        assert.equal((await fs.stat(fixture.state.cleanup.diagnosticPath)).mode&0o777,0o600);
        t.diagnostic('Controlled cleanup diagnostic retained at '+fixture.state.cleanup.diagnosticPath);
    });
});
