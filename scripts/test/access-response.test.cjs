const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createRequire}=require('node:module');
const {createServer}=require('node:http');
const {randomBytes}=require('node:crypto');
const requireGateway=createRequire(path.resolve('services/api-gateway/package.json'));
const dist=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
const {filterResponse}=requireGateway(path.join(dist,'proxy/access-response.js'));
const {ProxyService}=requireGateway(path.join(dist,'proxy/proxy.service.js'));
const {canonicalAccessRoute}=require('../../services/shared/access-route.cjs');
const claims={email:'observer@example.test',userRoles:['Наблюдатель'],projects:[{projectId:'prj-owned',projectName:'owned',role:'Наблюдатель'}],pluginIds:[],skillPaths:[]};
const cases=[
    ['/api/skills',[
        {path:'project-prj-owned/public'},{path:'project-prj-foreign/private'},{path:'common/private'},
    ],[{path:'project-prj-owned/public'}]],
    ['/api/skills/tree',[
        {name:'owned',children:[{path:'project-prj-owned/public'}]},
        {name:'foreign',children:[{path:'project-prj-foreign/private'}]},
    ],[{name:'owned',children:[{path:'project-prj-owned/public'}]}]],
    ['/api/rag/projects',{projects:[{projectKey:'prj-owned'},{projectKey:'prj-foreign'}]},
        {projects:[{projectKey:'prj-owned'}]}],
    ['/api/access/users',{users:[
        {principalName:'member@example.test',accesses:[{projectId:'prj-owned'},{projectId:'prj-foreign'}]},
        {principalName:'foreign@example.test',accesses:[{projectId:'prj-foreign'}]},
    ]},{users:[{principalName:'member@example.test',accesses:[{projectId:'prj-owned'}]}]}],
];

for(const [route,data,expected] of cases){
    for(const suffix of ['', '/', '///', '%2F']){
        test(`${route}${suffix}: чужие данные не проходят через вариант пути`,()=>{
            assert.deepEqual(filterResponse(data,claims,'Наблюдатель',route+suffix),expected);
        });
    }
    test(`${route}: одинарное URL-кодирование совпадает с авторизацией`,()=>{
        const encoded=route.replace('/api/'+route[5],'/api/%'+route.charCodeAt(5).toString(16));
        assert.equal(canonicalAccessRoute(encoded),route);
        assert.deepEqual(filterResponse(data,claims,'Наблюдатель',encoded),expected);
    });
    test(`${route}/: настоящий forward фильтрует ответ и не меняет исходный upstream URL`,async()=>{
        const forwarded=[];let result,status;
        const service=new ProxyService({get:()=>undefined},{authenticate:async()=>({userId:'observer',email:claims.email,activeRole:'Наблюдатель',policies:{}})},{mutation:()=>{}});
        service.http={post:async()=>({status:201,data:{allowed:true,claims}}),request:async options=>{
            forwarded.push(options.url);return {status:200,headers:{'content-type':'application/json'},data};
        }};
        const response={status(value){status=value;return this;},setHeader(){},send(value){result=value;},json(value){result=value;}};
        await service.forward({path:route+'/',method:'GET',headers:{},query:{},body:undefined},response);
        assert.equal(status,200);assert.deepEqual(result,expected);assert.ok(forwarded[0].endsWith(route+'/'));
    });
}

for(const route of ['/api/skills/%','/api/skills/%2e%2e','/api/skills/%5c']){
    test(`${route}: повреждённый или опасный путь не возвращает приватный ответ`,()=>{
        assert.equal(canonicalAccessRoute(route),undefined);
        assert.throws(()=>filterResponse([{path:'project-prj-foreign/private'}],claims,'Наблюдатель',route));
    });
}

test('Главный администратор сохраняет полный список; двойное кодирование не декодируется повторно',()=>{
    assert.deepEqual(filterResponse(cases[0][1],claims,'Главный админ','/api/skills/'),cases[0][1]);
    assert.equal(canonicalAccessRoute('/api/skills/%252F'),'/api/skills/%2F');
});

test('Настоящий HTTP/Axios проход: завершающий слеш не раскрывает чужие списки',async()=>{
    const catalogDist=process.env.PUBLICATION_TEST_DIST||path.resolve('services/catalog-service/dist');
    const {allowRequest}=require(path.join(catalogDist,'access/access-policy.js'));
    const scopedClaims={...claims,userRoles:['Наблюдатель','Админ проекта']};
    let role='Наблюдатель',upstream,gateway;
    const previousToken=process.env.NEUROCENTER_INTERNAL_TOKEN,token=randomBytes(24).toString('hex');
    process.env.NEUROCENTER_INTERNAL_TOKEN=token;
    const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const close=server=>server&&new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    try{
        upstream=createServer(async(req,res)=>{
            res.setHeader('content-type','application/json');
            if(req.headers['x-neurocenter-internal']!==token){res.writeHead(403);res.end('{}');return;}
            if(req.url==='/internal/access/authorize'){
                const chunks=[];for await(const chunk of req)chunks.push(chunk);
                const input=JSON.parse(Buffer.concat(chunks).toString());
                res.writeHead(201);res.end(JSON.stringify({allowed:allowRequest(scopedClaims,input.activeRole,input),claims:scopedClaims}));return;
            }
            const item=cases.find(([route])=>route===req.url.replace(/\/+$/,''));
            res.writeHead(item?200:404);res.end(JSON.stringify(item?.[1]||{}));
        });await listen(upstream);
        const endpoint='http://127.0.0.1:'+upstream.address().port;
        const service=new ProxyService({get:()=>endpoint},{authenticate:async()=>({userId:'observer',email:claims.email,activeRole:role,policies:{}})},{mutation:()=>{}});
        gateway=createServer((req,res)=>{
            req.path=new URL(req.url,'http://local.test').pathname;req.query={};
            res.status=value=>{res.statusCode=value;return res;};
            res.send=value=>res.end(JSON.stringify(value));res.json=res.send;
            void service.forward(req,res);
        });await listen(gateway);
        for(const [route,,expected] of cases){
            role=route==='/api/access/users'?'Админ проекта':'Наблюдатель';
            for(const suffix of ['','/']){
                const response=await fetch('http://127.0.0.1:'+gateway.address().port+route+suffix);
                assert.equal(response.status,200);assert.deepEqual(await response.json(),expected);
            }
        }
    }finally{await close(gateway);await close(upstream);if(previousToken===undefined)delete process.env.NEUROCENTER_INTERNAL_TOKEN;else process.env.NEUROCENTER_INTERNAL_TOKEN=previousToken;}
});
