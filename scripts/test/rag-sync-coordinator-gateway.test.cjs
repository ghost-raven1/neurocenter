const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {ProxyService}=require(path.join(process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist'),'proxy/proxy.service.js'));

/** Публичная запись проходит единственный coordinator; чтение сохраняет RAG service. */
function fixture(){
    const calls=[];
    const service=new ProxyService({get:key=>({CATALOG_SERVICE_URL:'http://catalog.fixture',RAG_SERVICE_URL:'http://rag.fixture'}[key])},
        {authenticate:async()=>({userId:'fixture',email:'fixture@example.test',activeRole:'Разработчик',policies:[]})},{mutation:()=>{}});
    service.http={post:async()=>({status:200,data:{allowed:true,claims:{projects:[],pluginIds:[],skillPaths:[]}}}),
        get:async()=>({status:200,data:{flags:{model_hosting:true,tool_builds:true,rag_sync:true}}}),
        request:async options=>{calls.push(options);return {status:200,data:{ok:true},headers:{}};}};
    const response={statusCode:0,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;},send(value){this.body=value;return this;},setHeader(){}};
    return {service,calls,response};
}
for(const [method,resource,target]of [
    ['POST','/api/rag/sync','http://catalog.fixture'],
    ['POST','/api/rag/sync/','http://catalog.fixture'],
    ['POST','/api/rag/%73ync/','http://catalog.fixture'],
    ['GET','/api/rag/sync','http://rag.fixture'],
    ['POST','/api/rag/search','http://rag.fixture'],
    ['GET','/api/rag/files','http://rag.fixture'],
])test(`${method} ${resource} → ${target}`,async()=>{
    const f=fixture(),body={projectKey:'prj-fixture',generation:'gen-fixture',expectedSnapshot:'snapshot-fixture'};
    const req=Object.assign(new EventEmitter(),{path:resource,method,headers:{},query:{},body});
    await f.service.forward(req,f.response);assert.equal(f.response.statusCode,200);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,target+(target==='http://catalog.fixture'?'/api/rag/sync':resource));assert.deepEqual(f.calls[0].data,body);
});
