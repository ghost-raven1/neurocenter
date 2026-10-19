const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createObservability}=require('../../services/shared/observability.cjs');

async function fixture(t,token='fixture-only'){
    const metrics=createObservability({service:'skills-service',token:()=> token});
    const server=http.createServer((req,res)=>metrics.middleware(req,res,()=>{res.statusCode=req.url.startsWith('/api/failure')?503:200;res.end('ok');}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base='http://127.0.0.1:'+server.address().port;
    return {metrics,request:(route,options)=>fetch(base+route,options)};
}
test('Метрики требуют отдельный внутренний секрет и не принимают пользовательскую сессию',async t=>{
    const {request}=await fixture(t);
    for(const headers of [{},{'x-neurocenter-internal':'fixture-only'},{Cookie:'bridge_session=fixture-only'},{Authorization:'Bearer wrong'},{'x-neurocenter-metrics':['wrong']}]){
        assert.equal((await request('/metrics',{headers})).status,403);
    }
    const authorized=await request('/metrics',{headers:{Authorization:'Bearer fixture-only'}});assert.equal(authorized.status,200);
    assert.equal(authorized.headers.get('cache-control'),'no-store');assert.match(authorized.headers.get('content-type'),/version=0.0.4/);
    assert.equal((await request('/metrics',{method:'POST',headers:{'x-neurocenter-metrics':'fixture-only'}})).status,405);
});
test('Счётчики и гистограмма отражают успешные запросы и ошибки без двойного учёта',async t=>{
    const {request}=await fixture(t);
    await request('/api/projects/secret-project');await request('/api/failure');await request('/auth/callback?code=private-code');
    const response=await request('/metrics',{headers:{'x-neurocenter-metrics':'fixture-only'}});const text=await response.text();
    assert.match(text,/requests_total\{service="skills-service",method="GET",group="api",status="200"\} 1/);
    assert.match(text,/requests_total\{service="skills-service",method="GET",group="api",status="503"\} 1/);
    assert.match(text,/duration_seconds_count\{service="skills-service",method="GET",group="api"\} 2/);
    assert.match(text,/http_in_flight\{service="skills-service"\} 0/);
    assert.equal(/secret-project|private-code|fixture-only|callback/.test(text),false);
    assert.equal(text.includes('group="metrics"'),false);
});
test('Произвольные маршруты не увеличивают число наборов меток',async t=>{
    const {request,metrics}=await fixture(t);
    for(let i=0;i<30;i++){await request('/user-'+i+'?email=private@example.test');}
    assert.match(metrics.render(),/requests_total\{service="skills-service",method="GET",group="other",status="200"\} 30/);
    assert.equal(metrics.render().includes('private@'),false);
});
test('Неизвестное имя сервиса не попадает в метки Prometheus',()=>{
    assert.throws(()=>createObservability({service:'injected"label'}),/Неизвестный/);
});
test('Без настроенного секрета endpoint закрыт даже при переданном Bearer',async t=>{
    const {request}=await fixture(t,'');
    assert.equal((await request('/metrics',{headers:{Authorization:'Bearer fixture-only'}})).status,403);
});
test('Разрыв клиентского соединения освобождает счётчик активных запросов',async t=>{
    const metrics=createObservability({service:'skills-service'});
    let entered;const started=new Promise(resolve=>{entered=resolve;});
    let closed;const finished=new Promise(resolve=>{closed=resolve;});
    const server=http.createServer((req,res)=>{res.once('close',closed);metrics.middleware(req,res,entered);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    const request=http.get('http://127.0.0.1:'+server.address().port+'/unfinished');request.on('error',()=>{});
    await started;request.destroy();await finished;
    assert.match(metrics.render(),/http_in_flight\{service="skills-service"\} 0/);
    assert.match(metrics.render(),/requests_total\{service="skills-service",method="GET",group="other",status="499"\} 1/);
});
