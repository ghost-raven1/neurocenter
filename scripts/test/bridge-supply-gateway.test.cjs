const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const http=require('node:http');
const {createHash}=require('node:crypto');
const {EventEmitter,once}=require('node:events');
const {Writable,Readable}=require('node:stream');
const {setImmediate:tick}=require('node:timers/promises');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
require('node:module').createRequire(path.join(directory,'entry.cjs'))('reflect-metadata');
const {BridgeSupplyService,bridgeRequest}=require(path.join(directory,'bridge/bridge-supply.service.js'));
const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js'));
const {publicApiOrigin}=require(path.join(directory,'security/browser-security.js'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const archive=Buffer.from('synthetic-bridge-runtime');
function descriptor(version='9.8.7',payload=archive){
    const target='darwin-arm64',sha256=digest(payload),buildId='b'.repeat(64),bytes=payload.length;
    return {assetId:'neurocenter-bridge',version,buildId,sourceCommit:'c'.repeat(40),artifacts:[{
        file:`neurocenter-asset-sync-${target}-${version}.tgz`,target,sha256,bytes,
        metadata:{version,target,buildId,sha256,bytes,nodeVersion:'24.22.0',ragSupported:true,probeEngine:{version:'1.14.48',file:'bin/opencode-probe',sha256:'d'.repeat(64)}}}]};
}
/** Настоящий локальный HTTP upstream; ни GitHub, ни пользовательские архивы не затрагиваются. */
async function fixture(t,payload=archive){
    const calls=[],state={supply:descriptor('9.8.7',payload),status:200};
    const server=http.createServer((req,res)=>{
        calls.push({url:req.url,headers:req.headers});
        const url=new URL(req.url,'http://fixture');
        if(url.pathname==='/internal/asset-sources/bridge'){
            res.statusCode=state.status;res.setHeader('content-type','application/json');
            res.end(JSON.stringify(state.supply));return;
        }
        if(url.pathname==='/internal/asset-sources/blobs/'+digest(payload)){
            if(state.blob){state.blob(req,res);return;}
            res.setHeader('content-length',payload.length);res.setHeader('etag','"'+digest(payload)+'"');res.end(payload);return;
        }
        res.statusCode=404;res.end();
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const service=new BridgeSupplyService({get:key=>key==='CATALOG_SERVICE_URL'?`http://127.0.0.1:${server.address().port}`:undefined});
    return {service,state,calls};
}
class Response extends Writable {
    constructor(){super();this.headers={};this.parts=[];this.headersSent=false;this.statusCode=200;this.on('error',()=>{});}
    _write(chunk,_encoding,done){this.headersSent=true;this.parts.push(Buffer.from(chunk));done();}
    setHeader(key,value){this.headers[key.toLowerCase()]=String(value);return this;}
    removeHeader(key){delete this.headers[key.toLowerCase()];}
    status(value){this.statusCode=value;return this;}
    send(value){this.end(value);return this;}
    json(value){this.setHeader('content-type','application/json; charset=utf-8');this.end(JSON.stringify(value));return this;}
    get body(){return Buffer.concat(this.parts);}
}
const request=()=>Object.assign(new EventEmitter(),{params:{},query:{},aborted:false,headers:{host:'untrusted.example','x-forwarded-host':'untrusted.example'}});
const status=expected=>error=>error.getStatus?.()===expected;
function environment(t,key,value){const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}

test('Архив, JSON и SHA выдаются из одной exact imported version через internal token',async t=>{
    environment(t,'NEUROCENTER_INTERNAL_TOKEN','synthetic-private-internal-token');
    const f=await fixture(t),file=f.state.supply.artifacts[0].file;
    for(const suffix of ['.sha256','.json','']){
        const response=new Response();await f.service.runtime(file+suffix,new AbortController().signal,response);
        assert.equal(response.headers['cache-control'],'no-store');
        if(!suffix){assert.deepEqual(response.body,archive);assert.equal(response.headers['content-length'],String(archive.length));}
        else if(suffix==='.sha256')assert.equal(response.body.toString(),digest(archive)+'\n');
        else assert.deepEqual(JSON.parse(response.body),f.state.supply.artifacts[0].metadata);
    }
    assert.equal(f.calls.filter(call=>call.url.includes('/blobs/')).length,1);
    for(const call of f.calls){assert.equal(call.headers['x-neurocenter-internal'],'synthetic-private-internal-token');assert.equal(call.headers.authorization,undefined);}
    assert.ok(f.calls.filter(call=>call.url.includes('/bridge?')).every(call=>call.url.endsWith('?version=9.8.7')));
});
test('Настоящий HTTP runtime больше metadata-лимита 128KiB передаётся полностью с точным SHA',async t=>{
    const payload=Buffer.alloc(512*1024+17,0x5a),f=await fixture(t,payload),res=new Response();
    await f.service.runtime(f.state.supply.artifacts[0].file,new AbortController().signal,res);
    assert.equal(res.writableFinished,true);assert.equal(res.body.length,payload.length);assert.equal(digest(res.body),digest(payload));
    assert.equal(res.headers['content-length'],String(payload.length));assert.equal(f.calls.length,2);
});
test('Установщики закрепляют импортированную версию, Gateway origin и reconnect без package-version fallback',async t=>{
    environment(t,'BRIDGE_TEMPLATES_DIR',path.resolve('bridge-dist'));environment(t,'PANEL_URL','https://panel.fixture.example/path');
    environment(t,'API_PUBLIC_URL','https://gateway.fixture.example:8443');
    const f=await fixture(t),controller=new BridgeController(f.service);
    for(const method of ['installScript','installWindowsBridge']){
        const req=request(),res=new Response();req.query.reconnect='1';await controller[method](req,res);
        const text=res.body.toString();assert.ok(text.includes("'9.8.7'"));assert.ok(text.includes('https://gateway.fixture.example:8443/api/bridge'));
        assert.ok(text.includes(method==='installScript'?"DEFAULT_SITE_URL='https://panel.fixture.example'":"$HubUrl = 'https://panel.fixture.example'"));
        assert.equal(/https:\/\/panel.fixture.example\/api\/bridge|__BASE_URL__|__SITE_URL__|__BRIDGE_VERSION__|__RECONNECT__|untrusted.example/.test(text),false);
        assert.equal(res.headers['cache-control'],'no-store');assert.ok(text.includes(method==='installScript'?"RECONNECT='1'":"$Reconnect = '1'"));
    }
    assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.url==='/internal/asset-sources/bridge'));
    assert.equal(BridgeController.prototype.artifact,undefined);
});
test('Runtime-конфигурация и OpenCode используют тот же публичный Gateway, без upstream URL и заголовков',async t=>{
    environment(t,'BRIDGE_TEMPLATES_DIR',path.resolve('bridge-dist'));environment(t,'API_PUBLIC_URL','https://gateway.fixture.example:8443');
    environment(t,'VITE_API_PROXY_TARGET','http://api-gateway:4000');
    const f=await fixture(t),controller=new BridgeController(f.service);
    const configuration=new Response();await controller.configuration(request(),configuration);assert.deepEqual(JSON.parse(configuration.body),{origin:'https://gateway.fixture.example:8443'});
    for(const method of ['installOpenCodeScript','installOpenCodeWindows']){
        const req=request(),res=new Response();req.headers.forwarded='host=spoofed.example;proto=http';
        await controller[method](req,res);const text=res.body.toString();
        assert.ok(text.includes('https://gateway.fixture.example:8443/api/bridge'));
        assert.equal(/__BASE_URL__|untrusted.example|spoofed.example|api-gateway:4000/.test(text),false);
    }
    assert.equal(f.calls.length,0);
});
for(const [mode,expected]of [['development','http://localhost:4000'],['production','https://panel.fixture.example']]){
    test('Пустая публичная настройка использует безопасный default: '+mode,t=>{
        environment(t,'API_PUBLIC_URL','');environment(t,'NODE_ENV',mode);environment(t,'PANEL_URL','https://panel.fixture.example/path');
        assert.equal(publicApiOrigin(),expected);
    });
}
for(const value of ['not a URL','file:///tmp','ftp://host.test','https://owner:secret@host.test','https://host.test/path','https://host.test?x=1','https://host.test#fragment',' https://host.test','https://ho\nst.test']){
    test('Некорректный API_PUBLIC_URL не маскируется fallback: '+JSON.stringify(value),async t=>{
        environment(t,'API_PUBLIC_URL',value);assert.throws(()=>publicApiOrigin());
        await assert.rejects(new BridgeController({}).configuration(request(),new Response()));
    });
}
test('Исторический runtime остаётся exact: запрос old version не может получить новый head',async t=>{
    const f=await fixture(t),file=f.state.supply.artifacts[0].file;
    f.state.supply=descriptor('9.8.8');
    await assert.rejects(f.service.runtime(file,new AbortController().signal,new Response()),status(503));
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/internal/asset-sources/bridge?version=9.8.7');
});
test('Пустой новый источник не подменяется локальным bridge-dist архивом',async t=>{
    environment(t,'BRIDGE_TEMPLATES_DIR',path.resolve('bridge-dist'));
    const f=await fixture(t);f.state.status=404;f.state.supply={message:'not imported'};
    const res=new Response();await assert.rejects(new BridgeController(f.service).installScript(request(),res),error=>error.getStatus?.()===404&&error.getResponse().code==='BRIDGE_NOT_IMPORTED');
    assert.equal(res.body.length,0);assert.equal(f.calls.length,1);
});
for(const file of ['../runtime.tgz','neurocenter-asset-sync.tgz','neurocenter-asset-sync-darwin-arm64-latest.tgz','neurocenter-asset-sync-linux-x64-9.8.7.tgz/anything']){
    test('Неподходящее имя не достигает source: '+file,async t=>{
        const f=await fixture(t);await assert.rejects(f.service.runtime(file,new AbortController().signal,new Response()),status(404));assert.equal(f.calls.length,0);
    });
}
for(const [name,change]of [
    ['HTTP500',f=>{f.status=500;}],
    ['redirect',f=>{f.status=302;}],
    ['URL вместо imported bytes',f=>{f.supply.artifacts[0].url='https://github.com/fixture/private';}],
    ['несовпадение metadata',f=>{f.supply.artifacts[0].metadata.bytes++;}],
    ['SHA массив',f=>{f.supply.artifacts[0].sha256=[digest(archive)];}],
    ['дубли target',f=>{f.supply.artifacts.push(structuredClone(f.supply.artifacts[0]));}],
    ['неверный target',f=>{f.supply.artifacts[0].target='darwin-arm64-musl';}],
    ['ссылка в metadata',f=>{f.supply.artifacts[0].metadata.url='https://untrusted.example';}],
])test('Не проверенная поставка отклоняется: '+name,async t=>{
    const f=await fixture(t);change(f.state);await assert.rejects(f.service.supply(new AbortController().signal),status(503));assert.equal(f.calls.length,1);
});
for(const [name,blob]of [
    ['404',(_req,res)=>{res.statusCode=404;res.end();}],
    ['неверная длина',(_req,res)=>{res.setHeader('content-length',archive.length+1);res.setHeader('etag','"'+digest(archive)+'"');res.end(archive);}],
    ['неверный ETag',(_req,res)=>{res.setHeader('content-length',archive.length);res.setHeader('etag','"'+'f'.repeat(64)+'"');res.end(archive);}],
])test('Отказ blob не выдаёт ложный архив и не ищет другой источник: '+name,async t=>{
    const f=await fixture(t);f.state.blob=blob;const res=new Response();
    await assert.rejects(f.service.runtime(f.state.supply.artifacts[0].file,new AbortController().signal,res),status(503));
    assert.equal(res.body.length,0);assert.equal(f.calls.length,2);
});
for(const mode of ['corrupt','overflow','truncated'])test('Прерванный/изменённый поток уничтожает response: '+mode,async t=>{
    const f=await fixture(t),get=f.service.http.get.bind(f.service.http);
    f.service.http.get=async(url,options)=>url.includes('/blobs/')?{status:200,headers:{'content-length':String(archive.length),etag:'"'+digest(archive)+'"'},
        data:Readable.from([mode==='overflow'?Buffer.concat([archive,Buffer.from('overflow')]):mode==='truncated'?archive.subarray(1):Buffer.alloc(archive.length)])}:get(url,options);
    const res=new Response();await f.service.runtime(f.state.supply.artifacts[0].file,new AbortController().signal,res);assert.equal(res.destroyed,true);
});
test('Закрытый клиент не запускает supply и освобождает обработчики',async()=>{
    const req=request(),res=new Response();req.aborted=true;let calls=0;
    await bridgeRequest(req,res,async()=>{calls++;});assert.equal(calls,0);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('Закрытие одного клиента отменяет только его supply, повтор запускается отдельно',async()=>{
    const first=request(),second=request(),a=new Response(),b=new Response();let signals=[],finish;
    const pending=bridgeRequest(first,a,signal=>new Promise((_resolve,reject)=>{signals.push(signal);signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}));
    const survivor=bridgeRequest(second,b,signal=>new Promise(resolve=>{signals.push(signal);finish=resolve;}));
    first.aborted=true;first.emit('aborted');await pending;assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
    finish();await survivor;assert.equal(a.body.length,0);assert.equal(first.listenerCount('aborted'),0);assert.equal(second.listenerCount('aborted'),0);
});
test('Deadline возвращает504 и не оставляет ожидание активным',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const req=request(),res=new Response();
    const work=bridgeRequest(req,res,signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('deadline')),{once:true})));
    const failure=assert.rejects(work,status(504));t.mock.timers.tick(600000);await failure;
    assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);await tick();
});
