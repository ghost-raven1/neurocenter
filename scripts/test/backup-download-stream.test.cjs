const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer,get}=require('node:http');
const {once}=require('node:events');
const path=require('node:path');
const {ProxyService}=require(path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist','proxy/proxy.service.js'));
const route='/api/projects/prj-fixture/backups/backup-fixture/download';
const claims={email:'owner@example.test',userRoles:['Главный админ'],projects:[],pluginIds:[],skillPaths:[]};
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

/** Настоящий HTTP proxy использует только loopback fixture; рабочие сервисы и копии не затрагиваются. */
async function fixture(download,{allowed=true,authorize=async()=>{}}={}){
    const sockets=new Set();let downloads=0;
    const upstream=createServer(async(req,res)=>{
        if(req.url==='/internal/access/authorize'){req.resume();await authorize();res.setHeader('content-type','application/json');res.end(JSON.stringify({allowed,claims}));return;}
        downloads++;download(req,res);
    });
    upstream.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const service=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?`http://127.0.0.1:${upstream.address().port}`:undefined},
        {authenticate:async()=>({userId:'owner',email:claims.email,activeRole:'Главный админ',policies:{}})},{mutation(){}});
    const tasks=[];
    const gateway=createServer((req,res)=>{
        req.path=req.url;req.query={};res.status=function(status){this.statusCode=status;return this;};
        res.json=function(value){this.setHeader('content-type','application/json');this.end(JSON.stringify(value));return this;};
        res.send=function(value){this.end(typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value);return this;};
        tasks.push(service.forward(req,res));
    });
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    return {url:`http://127.0.0.1:${gateway.address().port}${route}`,downloads:()=>downloads,async close(){
        for(const socket of sockets)socket.destroy();gateway.closeAllConnections();upstream.closeAllConnections();
        await Promise.all([new Promise(resolve=>gateway.close(resolve)),new Promise(resolve=>upstream.close(resolve)),Promise.allSettled(tasks)]);
    }};
}

test('Первый фрагмент резервной копии достигает браузера до завершения upstream',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve);let receivedUpstream;
    const requested=new Promise(resolve=>receivedUpstream=resolve);
    const source=Buffer.from([0,255,80,71,68,77,80,0,128]);
    const app=await fixture(async(_req,res)=>{
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':source.length,'content-disposition':'attachment; filename="fixture.dump"'});
        res.write(source.subarray(0,5));receivedUpstream();await gate;res.end(source.subarray(5));
    });
    let request;const chunks=[];let first;
    const firstChunk=new Promise(resolve=>first=resolve);
    const completed=new Promise((resolve,reject)=>{
        request=get(app.url,res=>{res.on('data',chunk=>{chunks.push(chunk);first(true);});res.on('end',()=>resolve(res));res.on('error',reject);});
        request.on('error',reject);
    });
    try{
        await requested;
        const streamed=await Promise.race([firstChunk,wait(250).then(()=>false)]);
        release();const response=await completed;
        assert.equal(streamed,true,'Gateway буферизовал копию до EOF вместо передачи первого фрагмента');
        assert.deepEqual(Buffer.concat(chunks),source);assert.equal(response.headers['content-length'],String(source.length));
        assert.equal(response.headers['content-disposition'],'attachment; filename="fixture.dump"');
        assert.equal(response.headers['cache-control'],'no-store');
    }finally{release();request?.destroy();await app.close();}
});

test('Отмена скачивания браузером прерывает только его upstream',async()=>{
    let receivedUpstream,closedUpstream;const requested=new Promise(resolve=>receivedUpstream=resolve),closed=new Promise(resolve=>closedUpstream=resolve);
    const app=await fixture((_req,res)=>{
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':1024*100});
        const timer=setInterval(()=>res.write(Buffer.alloc(1024)),20);receivedUpstream();
        res.on('close',()=>{clearInterval(timer);closedUpstream(true);});
    });
    const request=get(app.url,res=>res.resume());request.on('error',()=>{});
    try{
        await requested;request.destroy();
        assert.equal(await Promise.race([closed,wait(300).then(()=>false)]),true,'Отменённый запрос продолжает читать резервную копию');
    }finally{request.destroy();await app.close();}
});

test('Отказ RBAC не открывает поток резервной копии',async()=>{
    const app=await fixture((_req,res)=>res.end('Недоступная копия'),{allowed:false});
    try{
        const response=await fetch(app.url);assert.equal(response.status,403);assert.equal(app.downloads(),0);
    }finally{await app.close();}
});

test('Ошибка каталога возвращает ограниченный JSON без бинарной копии',async()=>{
    const app=await fixture((_req,res)=>{res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({message:'Копия не найдена'}));});
    try{
        const response=await fetch(app.url);assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/application\/json/);
        assert.equal(typeof (await response.json()).message,'string');
    }finally{await app.close();}
});

test('Отмена до ответа проверки доступа не открывает резервную копию поздним ответом',async()=>{
    let release,started;const gate=new Promise(resolve=>release=resolve),checking=new Promise(resolve=>started=resolve);
    const app=await fixture((_req,res)=>res.end('Копия'),{authorize:async()=>{started();await gate;}});
    const request=get(app.url,res=>res.resume());request.on('error',()=>{});
    try{await checking;request.destroy();await wait(30);release();await wait(100);assert.equal(app.downloads(),0);}
    finally{release();request.destroy();await app.close();}
});

test('Частичная копия сохраняет статус, диапазон и двоичные байты',async()=>{
    const bytes=Buffer.from([255,0,128]);
    const app=await fixture((_req,res)=>{res.writeHead(206,{'content-type':'application/octet-stream','content-length':bytes.length,
        'content-range':'bytes 2-4/100','accept-ranges':'bytes'});res.end(bytes);});
    try{
        const response=await fetch(app.url,{headers:{range:'bytes=2-4'}});assert.equal(response.status,206);
        assert.equal(response.headers.get('content-range'),'bytes 2-4/100');assert.equal(response.headers.get('accept-ranges'),'bytes');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    }finally{await app.close();}
});

test('HEAD возвращает размер без тела и не требует буфера файла',async()=>{
    const app=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream','content-length':'123456789'});res.end();});
    try{
        const response=await fetch(app.url,{method:'HEAD'});assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),'123456789');
        assert.equal((await response.arrayBuffer()).byteLength,0);
    }finally{await app.close();}
});

test('Большая ошибка upstream не раскрывается и не буферизуется',async()=>{
    const app=await fixture((_req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.write('PRIVATE '.repeat(10000));});
    try{
        const response=await fetch(app.url);assert.equal(response.status,502);const text=await response.text();
        assert.ok(text.length<1000);assert.equal(text.includes('PRIVATE'),false);
    }finally{await app.close();}
});

test('Отсутствие достоверного размера отклоняет поток до начала ответа браузеру',async()=>{
    const app=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.write('binary');});
    try{const response=await fetch(app.url);assert.equal(response.status,502);assert.match(response.headers.get('content-type'),/application\/json/);await response.text();}
    finally{await app.close();}
});
