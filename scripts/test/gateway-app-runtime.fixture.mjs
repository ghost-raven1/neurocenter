import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const gateway=path.join(root,'services/api-gateway');
const requireGateway=createRequire(path.join(gateway,'package.json'));
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
const deadline=async(promise,milliseconds,message)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),milliseconds);})]);}
    finally{clearTimeout(timer);}
};
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;};
const closeServer=async server=>{
    if(!server?.listening)return;
    await deadline(new Promise((resolve,reject)=>{
        server.close(error=>error?reject(error):resolve());server.closeIdleConnections();server.closeAllConnections();
    }),5000,'Owned listener did not close');
};

/** Real Gateway AppModule/DI/HTTP and Socket.IO; only remote peers are synthetic. No main.ts bootstrap or MCP is executed. */
export async function startGatewayAppRuntime({afterApplicationClose}={}){
    const environment={...process.env},previousCwd=process.cwd();
    const nativeFetch=globalThis.fetch,nativeSetInterval=globalThis.setInterval,nativeClearInterval=globalThis.clearInterval;
    const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-gateway-app-runtime-')));
    const token=randomBytes(32).toString('hex'),cookie='runtime-session=owned';
    const role='Админ проекта',email='owner@gateway-runtime.test',project={id:'prj-runtime-owned',name:'Owned gateway runtime'};
    const origins=new Set(),peers=new Map(),httpOriginals=[],processOriginals=[];
    const timers=new Map(),activeDependencies=new Set();
    const state={calls:[],projects:[],authorizations:[],authStatus:200,accessAllowed:true,rag:'ready',skills:'ready',
        unknownDependencies:0,blockedFetches:0,blockedHttp:0,blockedProcesses:0,cleanup:null};
    let app,io,server,base,registration,closing,guardsInstalled=false;
    const {defaultFeatureFlags,evaluateFeatureFlags}=requireGateway(path.join(root,'services/shared/feature-flags.cjs'));
    state.flags=defaultFeatureFlags();

    function installGuards(){
        globalThis.fetch=(input,options)=>{
            const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
            if(!origins.has(url.origin)){state.blockedFetches++;throw new Error('HTTP target is outside the owned Gateway fixture');}
            return nativeFetch(input,options);
        };
        // Axios uses native HTTP, independently of the global fetch entry point.
        for(const[module,protocol]of [[http,'http:'],[https,'https:']])for(const method of ['request','get']){
            const native=module[method];httpOriginals.push([module,method,native]);
            module[method]=function(...args){
                const url=typeof args[0]==='string'||args[0] instanceof URL?new URL(args[0]):undefined;
                const options={...(url?{protocol:url.protocol,hostname:url.hostname,port:url.port}:{}),
                    ...(url?typeof args[1]==='object'?args[1]:{}:args[0])};
                const target=(options.protocol||protocol)+'//'+(options.hostname||options.host||'localhost')+':'+(options.port||((options.protocol||protocol)==='https:'?443:80));
                if(options.socketPath||options.createConnection||!origins.has(target)){
                    state.blockedHttp++;throw new Error('Native HTTP target is outside the owned Gateway fixture');
                }
                return Reflect.apply(native,this,args);
            };
        }
        for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){
            processOriginals.push([method,childProcess[method]]);
            childProcess[method]=()=>{state.blockedProcesses++;throw new Error('Child processes are outside the Gateway startup fixture');};
        }
        // Keep real clocks and real handles: an unref'ed idle timer must still be explicitly cleared at shutdown.
        globalThis.setInterval=(callback,milliseconds,...args)=>{
            const handle=nativeSetInterval(callback,milliseconds,...args);
            const mcpHost=new Error().stack?.includes('/features/mcp-host/host.ts:')??false;
            timers.set(handle,{mcpHost,cleared:false});return handle;
        };
        globalThis.clearInterval=handle=>{const timer=timers.get(handle);if(timer)timer.cleared=true;return nativeClearInterval(handle);};
        guardsInstalled=true;syncBuiltinESMExports();
    }
    const hostTimers=()=>[...timers.entries()].filter(([,timer])=>timer.mcpHost);

    async function close(){
        if(closing)return closing;
        closing=(async()=>{
            const errors=[],failures=[];
            let applicationClosed=false,httpListeningAfterApplicationClose=null;
            const finish=async(label,work)=>{try{await work();}catch(error){failures.push(label);errors.push(error);}};
            try{
                if(app)await finish('gateway application',async()=>{
                    await deadline(app.close(),10000,'Gateway application shutdown did not finish');applicationClosed=true;
                    httpListeningAfterApplicationClose=server?.listening??false;
                    assert.equal(httpListeningAfterApplicationClose,false,'The actual Gateway shutdown left its HTTP listener open');
                    if(afterApplicationClose)await afterApplicationClose();
                });
                if(io?.engine.clientsCount){
                    await finish('Socket.IO disposal',()=>assert.equal(io.engine.clientsCount,0,'Socket.IO retained a client after application shutdown'));
                    await finish('remaining Socket.IO transport',()=>deadline(new Promise(resolve=>io.close(resolve)),5000,'Owned Socket.IO cleanup did not finish'));
                }
                if(server?.listening)await finish('remaining gateway listener',()=>closeServer(server));
                for(const[name,peer]of peers)await finish(name+' peer',()=>closeServer(peer));
                await finish('dependency handlers',()=>deadline(Promise.all([...activeDependencies]),5000,'Dependency handlers did not finish'));
                await finish('MCP idle timer disposal',()=>{
                    assert.ok(hostTimers().every(([,timer])=>timer.cleared),'A real MCP idle timer was not cleared by application shutdown');
                });
            }finally{
                // A failed application close is still a failed test; dispose our remaining real clocks before restoring globals.
                for(const[handle,timer]of timers)if(!timer.cleared)nativeClearInterval(handle);
                const restore=[
                    ['source loader',()=>registration?.enabled(false)],
                    ['transport and process guards',()=>{
                        if(guardsInstalled){
                            globalThis.fetch=nativeFetch;globalThis.setInterval=nativeSetInterval;globalThis.clearInterval=nativeClearInterval;
                            for(const[module,method,native]of httpOriginals)module[method]=native;
                            for(const[method,native]of processOriginals)childProcess[method]=native;
                            syncBuiltinESMExports();
                        }
                    }],
                    ['working directory',()=>process.chdir(previousCwd)],
                    ['process environment',()=>{
                        for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];
                        Object.assign(process.env,environment);
                    }],
                ];
                for(const[label,work]of restore)try{work();}catch(error){failures.push(label);errors.push(error);}
            }
            state.cleanup={applicationClosed,httpListeningAfterApplicationClose,httpListening:server?.listening??false,socketClients:io?.engine.clientsCount??0,
                mcpTimersCreated:hostTimers().length,mcpTimersCleared:hostTimers().filter(([,timer])=>timer.cleared).length,
                peersListening:[...peers.values()].filter(peer=>peer.listening).length,failures};
            if(failures.length){
                state.cleanup.diagnosticPath=path.join(temporary,'cleanup-error.json');
                await fs.writeFile(state.cleanup.diagnosticPath,JSON.stringify({...state.cleanup,
                    errors:errors.map((error,index)=>({phase:failures[index],name:error?.name??'Unknown',code:error?.code??null}))},null,2)+'\n',{mode:0o600});
                throw new AggregateError(errors,'Owned Gateway cleanup failed: '+failures.join(', '));
            }
            await fs.rm(temporary,{recursive:true,force:true});return state.cleanup;
        })();
        return closing;
    }

    try{
        for(const key of Object.keys(process.env))delete process.env[key];
        for(const directory of ['home','tmp','mcp','templates','config'])await fs.mkdir(path.join(temporary,directory),{mode:0o700});
        Object.assign(process.env,{NODE_ENV:'production',PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',
            HOME:path.join(temporary,'home'),TMPDIR:path.join(temporary,'tmp'),TMP:path.join(temporary,'tmp'),TEMP:path.join(temporary,'tmp'),
            XDG_CONFIG_HOME:path.join(temporary,'config'),NEUROCENTER_MCP_HOST_DIR:path.join(temporary,'mcp'),
            BRIDGE_TEMPLATES_DIR:path.join(temporary,'templates'),NEUROCENTER_INTERNAL_TOKEN:token,BIND_HOST:'127.0.0.1'});
        process.chdir(temporary);assert.deepEqual(await fs.readdir(temporary),['config','home','mcp','templates','tmp']);
        const profile={user:{id:email,email,principalName:email,displayName:'Runtime owner',activeRole:role,userRoles:[role],routePermissions:[]},policies:{}};
        for(const name of ['auth','catalog','flags','rag','skills']){
            const peer=http.createServer((req,res)=>{
                const pending=(async()=>{
                    const url=new URL(req.url,'http://fixture'),route=url.pathname;
                    state.calls.push({peer:name,method:req.method,path:route});
                    if(name==='rag'&&state.rag==='refuse'){req.socket.destroy();return;}
                    if(name==='skills'&&state.skills==='unavailable')return json(res,503,{message:'Owned skills outage'});
                    if(route==='/ready')return json(res,200,{ok:true});
                    if(name==='auth'&&route==='/auth/me')return json(res,req.headers.cookie===cookie?state.authStatus:401,state.authStatus===200?profile:{message:'Owned auth refusal'});
                    const trusted=req.headers['x-neurocenter-internal']===token;
                    if(name==='flags'&&route==='/internal/feature-flags/evaluated')return json(res,trusted?200:403,trusted?evaluateFeatureFlags(state.flags):{});
                    if(name==='catalog'&&route==='/internal/access/authorize'&&req.method==='POST'){
                        let body='';for await(const bytes of req){body+=bytes;if(Buffer.byteLength(body)>65536)throw new Error('Fixture request exceeded its bound');}
                        state.authorizations.push({trusted,body:JSON.parse(body)});
                        return json(res,trusted?200:403,{allowed:state.accessAllowed,claims:{email,userRoles:[role],projects:[{projectId:project.id,projectName:project.name,role}],pluginIds:[],skillPaths:[]}});
                    }
                    if(name==='catalog'&&route==='/api/projects'&&req.method==='GET'){
                        state.projects.push({trusted,actor:JSON.parse(decodeURIComponent(req.headers['x-bridge-actor']||'%7B%7D')),query:url.search});
                        return json(res,trusted?200:403,trusted?[project]:{});
                    }
                    if(name==='rag'&&route==='/api/rag/projects')return json(res,200,{projects:[]});
                    if(name==='skills'&&route==='/api/skills')return json(res,200,[]);
                    state.unknownDependencies++;return json(res,451,{message:'Dependency action is outside this fixture'});
                })().catch(()=>{if(!res.headersSent)json(res,503,{message:'Owned dependency failed'});else res.destroy();})
                    .finally(()=>activeDependencies.delete(pending));
                activeDependencies.add(pending);
            });
            peers.set(name,peer);const origin=await listen(peer);origins.add(origin);
            process.env[({auth:'AUTH_SERVICE_URL',catalog:'CATALOG_SERVICE_URL',flags:'FEATURE_FLAGS_SERVICE_URL',rag:'RAG_SERVICE_URL',skills:'SKILLS_SERVICE_URL'})[name]]=origin;
        }
        installGuards();
        registration=requireGateway('ts-node').register({transpileOnly:true,project:path.join(gateway,'tsconfig.json')});
        requireGateway('reflect-metadata');
        const {NestFactory}=requireGateway('@nestjs/core'),{Server}=requireGateway('socket.io');
        const {AppModule}=requireGateway(path.join(gateway,'src/app.module.ts'));
        const {LiveService}=requireGateway(path.join(gateway,'src/live/live.service.ts'));
        app=await NestFactory.create(AppModule,{logger:false,abortOnError:false});server=app.getHttpServer();
        io=new Server(server,{path:'/socket.io'});app.get(LiveService).attach(io);
        await deadline(app.listen(0,'127.0.0.1'),15000,'Canonical Gateway startup did not finish');
        base='http://127.0.0.1:'+server.address().port;origins.add(base);
        return {app,io,state,temporary,project,role,email,close,hostTimers:()=>hostTimers().map(([handle,timer])=>({cleared:timer.cleared,referenced:handle.hasRef()})),
            snapshot:()=>({calls:state.calls.length,unknown:state.unknownDependencies,fetch:state.blockedFetches,http:state.blockedHttp,processes:state.blockedProcesses}),
            async request(route,{method='GET',body,status=200,authenticated=true,internal,headers={}}={}){
                const response=await nativeFetch(base+route,{method,redirect:'error',signal:AbortSignal.timeout(7000),
                    headers:{...(authenticated?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),
                        ...(internal?{'x-neurocenter-internal':internal==='valid'?token:internal}:{}),...headers},
                    body:body===undefined?undefined:JSON.stringify(body)});
                const text=await response.text();assert.equal(response.status,status,method+' '+route+' returned an unexpected status');
                return response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text;
            },
        };
    }catch(error){
        try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Canonical Gateway startup failed and cleanup was incomplete');}
        throw error;
    }
}
