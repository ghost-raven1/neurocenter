const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {setImmediate:tick}=require('node:timers/promises');
const {ProxyService}=require(path.join(process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist'),'proxy/proxy.service.js'));
function request(input={}){return Object.assign(new EventEmitter(),{method:'POST',path:'/api/device-channel/embedding',headers:{authorization:'Bearer fixture'},body:{input:['Синтетический текст']},aborted:false,...input});}
function fixture(auth=true){
    const calls=[],events=[];
    const authGuard={authenticate:async()=>auth?{deviceId:'fixture-device',email:'fixture@example.test',activeRole:'Разработчик'}:null};
    const proxy=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?'http://catalog.fixture':undefined},
        authGuard,
        {bridge:(...args)=>events.push(args)});
    proxy.http={post:async(...args)=>{calls.push(args);return {status:201,data:{ok:true}};}};
    const response=Object.assign(new EventEmitter(),{code:0,body:null,writes:0,destroyed:false,writableEnded:false,status(code){this.code=code;return this;},json(value){this.body=value;this.writes++;this.writableEnded=true;return this;}});
    return {proxy,calls,events,response,authGuard};
}
for(const suffix of ['embedding/context','embedding'])test('Узкий канал устройства поддерживает только '+suffix,async()=>{
    const f=fixture(),body={projectId:'prj-fixture',input:['Синтетический текст']};
    await f.proxy.forward(request({path:'/api/device-channel/'+suffix,headers:{authorization:'Bearer '+'a'.repeat(64),'x-bridge-actor':'forged'},body}),f.response);
    assert.equal(f.response.code,201);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'http://catalog.fixture/internal/device-channel/'+suffix);
    assert.deepEqual(f.calls[0][1],body);assert.equal(f.calls[0][2].headers.authorization,'Bearer '+'a'.repeat(64));
    assert.equal(f.calls[0][2].headers['x-bridge-actor'],undefined);assert.equal(f.events.length,0);
    if(suffix==='embedding'){assert.equal(f.calls[0][2].timeout,120000);assert.equal(f.calls[0][2].maxContentLength,8*1024*1024);}
});
test('Отозванный Bearer не достигает embedding-брокера',async()=>{
    const f=fixture(false);await f.proxy.forward(request({headers:{}}),f.response);
    assert.equal(f.response.code,401);assert.equal(f.calls.length,0);
});
test('Другие методы и вложенные маршруты не расширяют канал устройства',async()=>{
    for(const [method,path] of [['GET','/api/device-channel/embedding'],['POST','/api/device-channel/embedding/anything'],['POST','/api/models/model-fixture/ollama/api/embed']]){
        const f=fixture();await f.proxy.forward(request({method,path,headers:{}}),f.response);
        assert.equal(f.response.code,path.startsWith('/api/models/')?403:404);assert.equal(f.calls.length,0);
    }
});

/** Axios-адаптер держит запрос до ответа или отмены; реальная сеть и модели не используются. */
function pendingTransport(proxy){
    const calls=[];let active=0;
    proxy.http.post=(_url,_body,options)=>new Promise((resolve,reject)=>{
        active++;let settled=false;
        const finish=(action,value)=>{if(settled)return;settled=true;active--;options.signal?.removeEventListener('abort',abort);action(value);};
        const abort=()=>finish(reject,Object.assign(new Error('Отменён upstream'),{code:'ERR_CANCELED'}));
        options.signal?.addEventListener('abort',abort,{once:true});
        calls.push({signal:options.signal,complete:()=>finish(resolve,{status:201,data:{ok:true}})});
        if(options.signal?.aborted)abort();
    });
    return {calls,active:()=>active,complete:()=>calls.forEach(call=>call.complete())};
}
for(const event of ['aborted','response-close'])test('Отмена embedding '+event+' завершает upstream до явного повтора',async()=>{
    const f=fixture(),transport=pendingTransport(f.proxy),req=request();
    const first=f.proxy.forward(req,f.response);let retry;
    try{
        await tick();assert.equal(transport.active(),1);
        if(event==='aborted'){req.aborted=true;req.emit('aborted');}
        else{f.response.destroyed=true;f.response.emit('close');}
        await tick();assert.equal(transport.calls[0].signal?.aborted,true);
        await first;assert.equal(transport.active(),0);assert.equal(f.response.writes,0);
        assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
        const next=fixture();next.proxy.http=f.proxy.http;retry=next.proxy.forward(request(),next.response);
        await tick();assert.equal(transport.active(),1);assert.equal(transport.calls.length,2);
        transport.complete();await retry;assert.equal(next.response.code,201);
    }finally{transport.complete();await Promise.allSettled([first,...(retry?[retry]:[])]);}
});
for(const closed of ['request','response'])test('Закрытие embedding во время авторизации '+closed+' не запускает поздний inference',async()=>{
    const f=fixture(),req=request();let release;
    f.authGuard.authenticate=()=>new Promise(resolve=>{release=()=>resolve({deviceId:'fixture-device',email:'fixture@example.test'});});
    const work=f.proxy.forward(req,f.response);
    try{
        await tick();
        if(closed==='request'){req.aborted=true;req.emit('aborted');}
        else{f.response.destroyed=true;f.response.emit('close');}
        release();await work;assert.equal(f.calls.length,0);assert.equal(f.response.writes,0);
        assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
    }finally{release?.();await work;}
});
for(const closed of ['request','response'])test('Уже закрытый embedding '+closed+' не достигает брокера',async()=>{
    const f=fixture(),req=request();if(closed==='request')req.aborted=true;else f.response.destroyed=true;
    await f.proxy.forward(req,f.response);assert.equal(f.calls.length,0);assert.equal(f.response.writes,0);
    assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
});
test('Обычный request.close не отменяет embedding, а нормальный response.close не отзывает завершённый запрос',async()=>{
    const f=fixture(),transport=pendingTransport(f.proxy),req=request(),work=f.proxy.forward(req,f.response);
    try{
        await tick();req.emit('close');assert.ok(transport.calls[0].signal instanceof AbortSignal);assert.equal(transport.calls[0].signal.aborted,false);
        transport.complete();await work;f.response.emit('close');assert.equal(transport.calls[0].signal.aborted,false);
        assert.equal(f.response.code,201);assert.equal(f.response.writes,1);
        assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
    }finally{transport.complete();await work;}
});
test('Ошибка upstream оставляет прежний bounded502 и освобождает слушатели embedding',async()=>{
    const f=fixture(),req=request();f.proxy.http.post=async()=>{throw Object.assign(new Error('PRIVATE upstream timeout'),{code:'ECONNABORTED'});};
    await f.proxy.forward(req,f.response);assert.equal(f.response.code,502);assert.equal(f.response.writes,1);
    assert.equal(JSON.stringify(f.response.body).includes('PRIVATE'),false);
    assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
});
test('Ошибка проверки Bearer очищает слушатели embedding и сохраняет отказ авторизации',async()=>{
    const f=fixture(),req=request(),failure=new Error('Отказ проверки доступа');f.authGuard.authenticate=async()=>{throw failure;};
    await assert.rejects(f.proxy.forward(req,f.response),failure);
    assert.equal(f.calls.length,0);assert.equal(f.response.writes,0);
    assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
});
test('Поздний отказ Bearer после закрытия embedding не достигает глобального обработчика ответа',async()=>{
    const f=fixture(),req=request();let rejectAuth;
    f.authGuard.authenticate=()=>new Promise((_resolve,reject)=>{rejectAuth=reject;});
    const work=f.proxy.forward(req,f.response);work.catch(()=>{});
    await tick();f.response.destroyed=true;f.response.emit('close');rejectAuth(new Error('Поздний отказ авторизации'));
    await assert.doesNotReject(work);assert.equal(f.calls.length,0);assert.equal(f.response.writes,0);
    assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
});
for(const outcome of ['success','error'])test('Поздний '+outcome+' embedding не пишет в уже закрытый response',async()=>{
    const f=fixture(),req=request();
    f.proxy.http.post=async()=>{f.response.destroyed=true;if(outcome==='error')throw new Error('PRIVATE timeout');return {status:201,data:{ok:true}};};
    await f.proxy.forward(req,f.response);assert.equal(f.response.writes,0);
    assert.equal(req.listenerCount('aborted'),0);assert.equal(f.response.listenerCount('close'),0);
});
test('Отмена одного embedding сохраняет соседний запрос к той же модели',async()=>{
    const f=fixture(),other=fixture(),transport=pendingTransport(f.proxy),first=request(),second=request();
    const cancelled=f.proxy.forward(first,f.response),survivor=f.proxy.forward(second,other.response);
    try{
        await tick();assert.equal(transport.active(),2);first.aborted=true;first.emit('aborted');await tick();
        assert.equal(transport.active(),1);assert.equal(transport.calls[0].signal.aborted,true);assert.equal(transport.calls[1].signal.aborted,false);
        transport.complete();await Promise.all([cancelled,survivor]);assert.equal(f.response.writes,0);assert.equal(other.response.code,201);
        assert.equal(transport.calls.length,2);assert.equal(first.listenerCount('aborted'),0);assert.equal(second.listenerCount('aborted'),0);
    }finally{transport.complete();await Promise.allSettled([cancelled,survivor]);}
});
