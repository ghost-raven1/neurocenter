const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {createServer}=require('node:http');
const dist=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
const {AuthGuardService}=require(path.join(dist,'auth/auth-guard.service.js'));
const {ProxyService}=require(path.join(dist,'proxy/proxy.service.js'));
const {ProxyController}=require(path.join(dist,'proxy/proxy.controller.js'));

const user={id:'fixture-user',email:'fixture@example.test',principalName:'fixture@example.test',activeRole:'Разработчик',
    displayName:'Синтетический разработчик',userRoles:['Разработчик'],routePermissions:[]};
const identity={id:'fixture-device',email:user.email,role:user.activeRole};
const profile={user,policies:{}};
const bearer={authorization:'Bearer '+'a'.repeat(64)};
const cookie={cookie:'bridge_session=synthetic-valid-session'};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
const config={get:()=>undefined};

for(const [name,headers,method,data] of [['Сессия',cookie,'get',profile],['Устройство',bearer,'post',identity]]) {
    for(const status of [401,403])test(`${name}: окончательный отказ ${status} остаётся неавторизованным`,async()=>{
        const guard=new AuthGuardService(config);guard.http={[method]:async()=>({status,data:{}})};
        assert.equal(await guard.authenticate({headers}),null);
    });
    for(const status of [429,500,503,302])test(`${name}: зависимость ${status} не превращается в ложный401`,async()=>{
        const guard=new AuthGuardService(config);guard.http={[method]:async()=>({status,data:{}})};
        await assert.rejects(guard.authenticate({headers}),error=>error.getStatus()===503);
    });
    for(const code of ['ECONNREFUSED','ECONNABORTED'])test(`${name}: ${code} закрывает доступ с временным503`,async()=>{
        const guard=new AuthGuardService(config);guard.http={[method]:async()=>{throw Object.assign(new Error('Synthetic dependency error'),{code});}};
        await assert.rejects(guard.authenticate({headers}),error=>error.getStatus()===503&&!JSON.stringify(error.getResponse()).includes('Synthetic'));
    });
    test(`${name}: действительный ответ возвращает только свежую identity`,async()=>{
        const guard=new AuthGuardService(config);guard.http={[method]:async()=>({status:200,data})};
        assert.deepEqual(await guard.authenticate({headers}),{...(name==='Устройство'?{deviceId:identity.id}:{}),
            email:user.email,activeRole:user.activeRole,userId:name==='Устройство'?user.email:user.id,
            principalName:user.principalName,userRoles:user.userRoles,policies:{}});
    });
    for(const malformed of [null,{},[],{user:{...user,email:null},policies:{}},{id:null,email:user.email,role:user.activeRole}]) {
        test(`${name}: неполная identity не передаётся ресурсу`,async()=>{
            const guard=new AuthGuardService(config);guard.http={[method]:async()=>({status:200,data:malformed})};
            await assert.rejects(guard.authenticate({headers}),error=>error.getStatus()===503);
        });
    }
}

test('Устройство поддерживает Nest201, а неверный Bearer не опрашивает сервисы',async()=>{
    let calls=0;const guard=new AuthGuardService(config);
    guard.http={post:async()=>{calls++;return {status:201,data:identity};}};
    assert.equal((await guard.authenticate({headers:bearer})).deviceId,identity.id);
    assert.equal(await guard.authenticate({headers:{authorization:'Bearer invalid',...cookie}}),null);
    assert.equal(calls,1);
});

test('Контроллер возвращает Promise проверки в Nest вместо потерянного rejection',async()=>{
    const cause=Object.assign(new Error('Synthetic unavailable'),{status:503});
    const controller=new ProxyController({forward:async()=>{throw cause;}});
    await assert.rejects(controller.all({},{}),error=>error===cause);
});

/** Запускает настоящие socket-callbacks main без открытия портов и реальных таймеров. */
async function socketCallbacks(authenticate) {
    const callbacks={};const auth={authenticate};
    const app={enableShutdownHooks(){},use(){},getHttpServer(){return {};},
        get:token=>token===AuthGuardService?auth:{attach(){},bridge(){}},listen:async()=>{callbacks.ready=true;}};
    const nativeRequire=createRequire(path.join(dist,'main.js'));
    const context={exports:{},process,console:{log(){}},
        setInterval:callback=>{callbacks.poll=callback;return 'fixture-timer';},clearInterval(){callbacks.timerCleared=true;},
        require:id=>{
            if(id==='@nestjs/core')return {NestFactory:{create:async()=>app}};
            if(id==='socket.io')return {Server:class{use(callback){callbacks.middleware=callback;}on(event,callback){callbacks[event]=callback;}}};
            if(id==='../../shared/runtime.cjs'||id==='./app.module')return {};
            if(id==='../../shared/observability.cjs')return {createObservability:()=>({middleware(){}})};
            return nativeRequire(id);
        }};
    vm.runInNewContext(fs.readFileSync(path.join(dist,'main.js'),'utf8'),context,{filename:path.join(dist,'main.js')});
    for(let index=0;index<5&&!callbacks.ready;index++)await Promise.resolve();
    assert.equal(callbacks.ready,true);return callbacks;
}

test('WebSocket отклоняет handshake при недоступной проверке и отключает старую комнату после сбоя повторной проверки',async()=>{
    let unavailable=true,disconnected=false,error,disconnectHandler;
    const callbacks=await socketCallbacks(async()=>{if(unavailable)throw Error('Synthetic auth outage');return {email:user.email};});
    const socket={handshake:{auth:{}},request:{headers:cookie},data:{},join:async()=>{},
        on:(_event,callback)=>{disconnectHandler=callback;},disconnect:()=>{disconnected=true;disconnectHandler?.();}};
    await callbacks.middleware(socket,value=>{error=value;});
    assert.match(error.message,/временно недоступна/);assert.equal(socket.data.user,undefined);
    unavailable=false;await callbacks.middleware(socket,value=>{error=value;});assert.equal(error,undefined);
    callbacks.connection(socket);unavailable=true;callbacks.poll();
    for(let index=0;index<5;index++)await Promise.resolve();
    assert.equal(disconnected,true);assert.equal(callbacks.timerCleared,true);
});

test('Настоящий HTTP: временный отказ сохраняет сессию, блокирует ресурс и восстанавливается без нового входа',async()=>{
    let authStatus=503,resourceCalls=0,accessCalls=0,identityStatus=503;
    const observedCookies=[];
    const auth=createServer((req,res)=>{
        observedCookies.push(req.headers.cookie);res.statusCode=authStatus;res.setHeader('content-type','application/json');
        res.end(JSON.stringify(authStatus===200?profile:{message:'Синтетический отказ проверки прав'}));
    });
    const catalog=createServer((req,res)=>{
        req.resume();res.setHeader('content-type','application/json');
        if(req.url==='/internal/device-channel/identity'){res.statusCode=identityStatus;res.end(JSON.stringify(identityStatus===200?identity:{}));return;}
        if(req.url==='/internal/access/authorize'){
            accessCalls++;res.end(JSON.stringify({allowed:true,claims:{email:user.email,projects:[],skillPaths:[],pluginIds:[]}}));return;
        }
        resourceCalls++;res.end(JSON.stringify([]));
    });
    await listen(auth);await listen(catalog);
    const conf={get:key=>key==='AUTH_SERVICE_URL'?`http://127.0.0.1:${auth.address().port}`:key==='CATALOG_SERVICE_URL'?`http://127.0.0.1:${catalog.address().port}`:undefined};
    const controller=new ProxyController(new ProxyService(conf,new AuthGuardService(conf),{mutation(){}}));
    const gateway=createServer(async(req,res)=>{
        req.path='/api/projects';req.query={};
        res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};res.send=res.json;
        try{await controller.all(req,res);}catch(error){res.status(error.getStatus?.()||500).json(error.getResponse?.()||{});}
    });await listen(gateway);
    const request=headers=>fetch(`http://127.0.0.1:${gateway.address().port}/api/projects`,{headers});
    try {
        assert.equal((await request(cookie)).status,503);assert.equal(resourceCalls,0);assert.equal(accessCalls,0);
        assert.equal((await request(bearer)).status,503);assert.equal(resourceCalls,0);assert.equal(accessCalls,0);
        authStatus=200;identityStatus=200;
        assert.equal((await request(cookie)).status,200);assert.equal((await request(bearer)).status,200);
        assert.equal(resourceCalls,2);assert.equal(accessCalls,2);
        authStatus=401;identityStatus=403;
        assert.equal((await request(cookie)).status,401);assert.equal((await request(bearer)).status,401);
        assert.equal(resourceCalls,2);assert.equal(accessCalls,2);
        assert.ok(observedCookies.every(value=>value===cookie.cookie));
    }finally{await close(gateway);await close(auth);await close(catalog);}
});
