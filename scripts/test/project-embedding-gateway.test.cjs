const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {ProxyService}=require(path.join(process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist'),'proxy/proxy.service.js'));
function fixture(auth=true){
    const calls=[],events=[];
    const proxy=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?'http://catalog.fixture':undefined},
        {authenticate:async()=>auth?{deviceId:'fixture-device',email:'fixture@example.test',activeRole:'Разработчик'}:null},
        {bridge:(...args)=>events.push(args)});
    proxy.http={post:async(...args)=>{calls.push(args);return {status:201,data:{ok:true}};}};
    const response={code:0,body:null,status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
    return {proxy,calls,events,response};
}
for(const suffix of ['embedding/context','embedding'])test('Узкий канал устройства поддерживает только '+suffix,async()=>{
    const f=fixture(),body={projectId:'prj-fixture',input:['Синтетический текст']};
    await f.proxy.forward({method:'POST',path:'/api/device-channel/'+suffix,headers:{authorization:'Bearer '+'a'.repeat(64),'x-bridge-actor':'forged'},body},f.response);
    assert.equal(f.response.code,201);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'http://catalog.fixture/internal/device-channel/'+suffix);
    assert.deepEqual(f.calls[0][1],body);assert.equal(f.calls[0][2].headers.authorization,'Bearer '+'a'.repeat(64));
    assert.equal(f.calls[0][2].headers['x-bridge-actor'],undefined);assert.equal(f.events.length,0);
    if(suffix==='embedding'){assert.equal(f.calls[0][2].timeout,120000);assert.equal(f.calls[0][2].maxContentLength,8*1024*1024);}
});
test('Отозванный Bearer не достигает embedding-брокера',async()=>{
    const f=fixture(false);await f.proxy.forward({method:'POST',path:'/api/device-channel/embedding',headers:{}},f.response);
    assert.equal(f.response.code,401);assert.equal(f.calls.length,0);
});
test('Другие методы и вложенные маршруты не расширяют канал устройства',async()=>{
    for(const [method,path] of [['GET','/api/device-channel/embedding'],['POST','/api/device-channel/embedding/anything'],['POST','/api/models/model-fixture/ollama/api/embed']]){
        const f=fixture();await f.proxy.forward({method,path,headers:{}},f.response);
        assert.equal(f.response.code,path.startsWith('/api/models/')?403:404);assert.equal(f.calls.length,0);
    }
});
