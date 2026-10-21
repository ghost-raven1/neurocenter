const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createServer}=require('node:http');
const dist=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
const {requiredFeatureFlags,featureFlagsFailure}=require(path.join(dist,'features/feature-flag-gate.js'));
const {ProxyService}=require(path.join(dist,'proxy/proxy.service.js'));
const {defaultFeatureFlags,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');
const defaults=defaultFeatureFlags();
const claims={email:'admin@example.test',userRoles:['Главный админ'],projects:[],pluginIds:[],skillPaths:[]};

for(const [method,route,body,expected] of [
    ['POST','/api/models/model-a/hosting',{action:'start'},'model_hosting'],
    ['POST','/api/models/model-a/hosting/',{action:'check'},'model_hosting'],
    ['POST','/api/models/model-a/ollama/api/embed',{},'model_hosting'],
    ['POST','/api/models/model-a/ollama/v1/chat/completions',{},'model_hosting'],
    ['POST','/api/models/model-a/hosting',{action:'stop'},undefined],
    ['GET','/api/models/model-a/hosting',undefined,undefined],
    ['POST','/api/tool-builds',{},'tool_builds'],
    ['POST','/api/tool-builds/archive',{},'tool_builds'],
    ['GET','/api/tool-builds/repository',undefined,'tool_builds'],
    ['GET','/api/tool-builds/npm',undefined,'tool_builds'],
    ['GET','/api/tool-builds/build-a',undefined,undefined],
    ['GET','/api/tool-builds/requests/request-a',undefined,undefined],
    ['POST','/api/rag/sync',{},'rag_sync'],
    ['POST','/api/rag/%73ync/',{},'rag_sync'],
    ['GET','/api/rag/summary',undefined,undefined],
    ['POST','/api/device-jobs',{kind:'sync-rag'},'rag_sync'],
    ['POST','/api/device-jobs',{kind:'check-project'},undefined],
    ['PATCH','/api/feature-flags/rag_sync',{enabled:true},undefined],
])test(`${method} ${route}: флаг ограничивает только соответствующий новый запрос`,()=>{
    assert.deepEqual(requiredFeatureFlags(method,route,body),expected?[expected]:[]);
});

test('Изменение флага действует на следующий запрос без кеша',async()=>{
    let enabled=false,calls=0;
    const http={get:async(url,options)=>{calls++;assert.equal(url,'http://flags.test/internal/feature-flags/evaluated');assert.equal(options.timeout,3000);return {status:200,data:evaluateFeatureFlags({...defaults,model_hosting:enabled})};}};
    assert.equal((await featureFlagsFailure(http,'http://flags.test',['model_hosting'])).status,403);
    enabled=true;assert.equal(await featureFlagsFailure(http,'http://flags.test',['model_hosting']),undefined);
    assert.equal(calls,2);
});

for(const response of [{status:503,data:{}},{status:200,data:{flags:{...defaults,rag_sync:'true'}}},{status:200,data:{flags:{model_hosting:true}}}]) {
    test('Неисправный или неполный ответ не включает функцию по умолчанию',async()=>{
        const failure=await featureFlagsFailure({get:async()=>response},'http://flags.test',['model_hosting']);
        assert.equal(failure.status,503);assert.equal(failure.code,'feature-flags-unavailable');
    });
}

test('Ошибка подключения не раскрывает адрес и секреты в ответе пользователю',async()=>{
    const failure=await featureFlagsFailure({get:async()=>{throw Error('postgresql://private:secret@db');}},'http://flags.test',['tool_builds']);
    assert.equal(failure.status,503);assert.equal(JSON.stringify(failure).includes('secret'),false);
});

function response(){
    return {code:0,value:undefined,headers:{},status(code){this.code=code;return this;},setHeader(key,value){this.headers[key]=value;},json(value){this.value=value;},send(value){this.value=value;}};
}
function proxy({allowed=true,auth=true,flags={...defaults}}={}){
    const forwarded=[],lookups=[];
    const instance=new ProxyService({get:key=>key==='FEATURE_FLAGS_SERVICE_URL'?'http://flags.test':undefined},
        {authenticate:async()=>auth?{email:claims.email,userId:'admin',activeRole:'Главный админ',policies:{}}:null},{mutation(){}});
    instance.http={post:async()=>({status:200,data:{allowed,claims}}),get:async url=>{lookups.push(url);return {status:200,data:evaluateFeatureFlags(flags)};},
        request:async options=>{forwarded.push(options);return {status:200,headers:{},data:{ok:true}};}};
    return {instance,forwarded,lookups};
}

test('Отключённая упаковка не достигает upstream после проверки прав',async()=>{
    const app=proxy({flags:{...defaults,tool_builds:false}}),res=response();
    await app.instance.forward({method:'POST',path:'/api/tool-builds',headers:{},query:{},body:{}},res);
    assert.equal(res.code,403);assert.equal(res.value.feature,'tool_builds');assert.equal(app.forwarded.length,0);
    assert.equal(res.headers['Cache-Control'],'no-store');
});

test('Просмотр и выгрузка модели работают при недоступном сервисе флагов',async()=>{
    for(const [method,body] of [['GET',undefined],['POST',{action:'stop'}]]) {
        const app=proxy(),res=response();app.instance.http.get=async()=>{throw Error('flags down');};
        await app.instance.forward({method,path:'/api/models/model-a/hosting',headers:{},query:{},body},res);
        assert.equal(res.code,200);assert.equal(app.forwarded.length,1);assert.equal(app.lookups.length,0);
    }
});

test('Неавторизованный запрос и отказ роли не опрашивают флаги и upstream',async()=>{
    for(const options of [{auth:false},{allowed:false}]) {
        const app=proxy(options),res=response();
        await app.instance.forward({method:'POST',path:'/api/tool-builds',headers:{},query:{},body:{}},res);
        assert.equal(res.code,options.auth===false?401:403);assert.equal(app.lookups.length,0);assert.equal(app.forwarded.length,0);
    }
});

test('Управление флагом идёт в отдельный сервис и не зависит от его текущего значения',async()=>{
    const app=proxy({flags:{model_hosting:false,tool_builds:false,rag_sync:false}}),res=response();
    await app.instance.forward({method:'PATCH',path:'/api/feature-flags/model_hosting',headers:{},query:{},body:{enabled:true,expectedRevision:1}},res);
    assert.equal(res.code,200);assert.equal(app.lookups.length,0);
    assert.equal(app.forwarded[0].url,'http://flags.test/api/feature-flags/model_hosting');
});

test('Настоящий HTTP шлюз проверяет отключение, повторное включение и отказ сервиса',async()=>{
    let enabled=false,unavailable=false,received=0;
    const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    const flags=createServer((_req,res)=>{
        res.setHeader('content-type','application/json');res.statusCode=unavailable?503:200;
        res.end(JSON.stringify(evaluateFeatureFlags({...defaults,model_hosting:enabled})));
    });
    const catalog=createServer((req,res)=>{
        req.resume();res.setHeader('content-type','application/json');
        if(req.url==='/internal/access/authorize')res.end(JSON.stringify({allowed:true,claims}));
        else {received++;res.end(JSON.stringify({ok:true}));}
    });
    await listen(flags);await listen(catalog);
    const service=new ProxyService({get:key=>key==='FEATURE_FLAGS_SERVICE_URL'?`http://127.0.0.1:${flags.address().port}`:key==='CATALOG_SERVICE_URL'?`http://127.0.0.1:${catalog.address().port}`:undefined},
        {authenticate:async()=>({email:claims.email,userId:'admin',activeRole:'Главный админ',policies:{}})},{mutation(){}});
    const gateway=createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        req.path=new URL(req.url,'http://local.test').pathname;req.query={};req.body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
        res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};res.send=res.json;
        await service.forward(req,res);
    });
    await listen(gateway);
    try {
        const request=()=>fetch(`http://127.0.0.1:${gateway.address().port}/api/models/model-fixture/hosting`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'start',expectedRevision:1})});
        assert.equal((await request()).status,403);assert.equal(received,0);
        enabled=true;assert.equal((await request()).status,200);assert.equal(received,1);
        unavailable=true;assert.equal((await request()).status,503);assert.equal(received,1);
    }finally{await close(gateway);await close(catalog);await close(flags);}
});

test('Actual HTTP admission checks every implemented capability and observes re-enable without restart',async()=>{
 const cases=[
  ['model_hosting','POST','/api/models/m/hosting',{action:'start'}],['tool_builds','POST','/api/tool-builds/archive',{}],['rag_sync','POST','/api/rag/sync',{}],
  ['projects','POST','/api/projects',{}],['computer_connections','POST','/api/device-channel/pair/start',{}],['tool_catalog','POST','/api/ai-plugins',{}],['asset_sources','POST','/api/asset-imports',{}],['tool_installation','POST','/api/device-install-plans',{}],
  ['model_catalog','POST','/api/models',{}],['opencode_model_sync','POST','/api/models/import-opencode',{}],['agents','POST','/api/agents',{}],['model_chat','POST','/api/model-chats',{}],['group_chat','POST','/api/model-chats',{mode:'group'}],
  ['project_learning','POST','/api/projects/p/learning/experiences',{}],['project_search','POST','/api/rag/search',{}],['project_snapshots','POST','/api/projects/p/versions',{}],['project_backups','POST','/api/projects/p/backups',{}],['catalog_requests','POST','/api/catalog-requests',{}],['model_usage','GET','/api/model-usage',undefined],['local_changes','POST','/api/device-jobs',{kind:'prepare-local-change'}],['research_tools','POST','/api/model-chats/id/turns',{research:{project:false,external:{assetId:'native-pin'}}}],
 ];
 let configured=defaultFeatureFlags(),received=0;
 const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
 const upstream=createServer((req,res)=>{req.resume();res.setHeader('content-type','application/json');
  if(req.url==='/internal/feature-flags/evaluated')return res.end(JSON.stringify(evaluateFeatureFlags(configured)));
  if(req.url==='/internal/access/authorize')return res.end(JSON.stringify({allowed:true,claims}));
  received++;res.end(JSON.stringify({ok:true}));
 });await listen(upstream);const base=`http://127.0.0.1:${upstream.address().port}`;
 const proxy=new ProxyService({get:key=>['CATALOG_SERVICE_URL','FEATURE_FLAGS_SERVICE_URL','RAG_SERVICE_URL','SKILLS_SERVICE_URL'].includes(key)?base:undefined},{authenticate:async()=>({email:claims.email,activeRole:'Главный админ',policies:{}})},{mutation(){},bridge(){}});
 const gateway=createServer(async(req,res)=>{req.path=new URL(req.url,'http://fixture').pathname;req.query={};const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=JSON.parse(Buffer.concat(chunks).toString()||'{}');res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};res.send=res.json;try{await proxy.forward(req,res);}catch(error){res.statusCode=500;res.end(error.message);}});await listen(gateway);
 try{for(const [key,method,path,body]of cases){
  const request=()=>fetch(`http://127.0.0.1:${gateway.address().port}`+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const before=received;configured={...defaultFeatureFlags(),[key]:false};const denied=await request();assert.equal(denied.status,403,key);assert.equal((await denied.json()).feature,key);assert.equal(received,before,key+' must not reach data plane');
  configured=defaultFeatureFlags();const allowed=await request();assert.equal(allowed.status,200,key);await allowed.arrayBuffer();assert.equal(received,before+1,key+' re-enable must reach data plane once');
 }
 }finally{await close(gateway);await close(upstream);}
});
