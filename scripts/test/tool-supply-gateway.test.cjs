const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer,get}=require('node:http');
const {once}=require('node:events');
const path=require('node:path');
const {ProxyService}=require(path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist','proxy/proxy.service.js'));
const route='/api/tool-builds/11111111-1111-4111-8111-111111111111/supply';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const headers=length=>({'content-type':'application/gzip','content-length':length,'content-disposition':'attachment; filename="tool-1.0.0-supply.tar.gz"'});
async function fixture(download,{allowed=true,authorize=async()=>{}}={}){
 let downloads=0;const tasks=[],sockets=new Set();
 const upstream=createServer(async(req,res)=>{
  if(req.url==='/internal/access/authorize'){req.resume();await authorize();res.setHeader('content-type','application/json');res.end(JSON.stringify({allowed,claims:{userRoles:['Главный админ'],projects:[],pluginIds:[],skillPaths:[]}}));return;}
  downloads++;download(req,res);
 });upstream.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const proxy=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?`http://127.0.0.1:${upstream.address().port}`:undefined},{authenticate:async()=>({userId:'fixture',email:'fixture@example.test',activeRole:'Главный админ',policies:{}})},{mutation(){}});
 const gateway=createServer((req,res)=>{req.path=req.url.split('?')[0];req.query={};res.status=function(code){this.statusCode=code;return this;};res.json=function(value){this.setHeader('content-type','application/json');this.end(JSON.stringify(value));return this;};res.send=function(value){this.end(typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value);return this;};tasks.push(proxy.forward(req,res));});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 const base=`http://127.0.0.1:${gateway.address().port}`;
 return {url:base+route,base,downloads:()=>downloads,close:async()=>{for(const socket of sockets)socket.destroy();gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>gateway.close(resolve)),new Promise(resolve=>upstream.close(resolve)),Promise.allSettled(tasks)]);}};
}
test('Tool supply first binary chunk reaches browser before upstream EOF',async()=>{
 let first,release;const streamed=new Promise(resolve=>first=resolve),gate=new Promise(resolve=>release=resolve),bytes=Buffer.from([31,139,8,0,255,1,2,3]);
 const app=await fixture(async(_req,res)=>{res.writeHead(200,headers(bytes.length));res.write(bytes.subarray(0,4));await gate;res.end(bytes.subarray(4));});
 let request;const chunks=[];const completed=new Promise((resolve,reject)=>{request=get(app.url,res=>{res.on('data',chunk=>{chunks.push(chunk);first(true);});res.on('end',()=>resolve(res));res.on('error',reject);});request.on('error',reject);});
 try{const arrived=await Promise.race([streamed,wait(300).then(()=>false)]);release();const response=await completed;assert.equal(arrived,true);assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(response.headers['content-length'],String(bytes.length));assert.equal(response.headers['cache-control'],'no-store');assert.match(response.headers['content-disposition'],/supply.tar.gz/);}finally{release();request?.destroy();await app.close();}
});
test('Browser cancellation closes the corresponding supply upstream',async()=>{
 let started,closed;const opening=new Promise(resolve=>started=resolve),closing=new Promise(resolve=>closed=resolve);
 const app=await fixture((_req,res)=>{res.writeHead(200,headers(1024*100));const timer=setInterval(()=>res.write(Buffer.alloc(1024)),20);res.on('close',()=>{clearInterval(timer);closed(true);});started();});
 const request=get(app.url,res=>res.resume());request.on('error',()=>{});
 try{await opening;request.destroy();assert.equal(await Promise.race([closing,wait(500).then(()=>false)]),true);}finally{request.destroy();await app.close();}
});
test('HEAD forwards the cheap readiness check without preparing or buffering a body',async()=>{
 const app=await fixture((req,res)=>{assert.equal(req.method,'HEAD');res.writeHead(204);res.end();});
 try{const response=await fetch(app.url,{method:'HEAD'});assert.equal(response.status,204);assert.equal(await response.text(),'');assert.equal(response.headers.get('cache-control'),'no-store');}finally{await app.close();}
});
test('Denied authorization never requests supply bytes',async()=>{
 const app=await fixture((_req,res)=>res.end('must not open'),{allowed:false});try{assert.equal((await fetch(app.url)).status,403);assert.equal(app.downloads(),0);}finally{await app.close();}
});
test('A late access decision after browser close cannot open a supply',async()=>{
 let release,checking;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>checking=resolve);
 const app=await fixture((_req,res)=>res.end('must not open'),{authorize:async()=>{checking();await gate;}}),request=get(app.url,res=>res.resume());request.on('error',()=>{});
 try{await started;request.destroy();await wait(30);release();await wait(80);assert.equal(app.downloads(),0);}finally{release();request.destroy();await app.close();}
});
for(const status of [401,403,404,409,413,503,504,507])test('Supply upstream refusal '+status+' returns public bounded JSON',async()=>{
 const app=await fixture((_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end('{"message":"/private/operator/token"}');});try{const response=await fetch(app.url);assert.equal(response.status,status);assert.match(response.headers.get('content-type'),/application\/json/);assert.doesNotMatch(await response.text(),/private|operator|token/);}finally{await app.close();}
});
for(const mode of ['too-large','no-length','private-filename','wrong-type'])test('Rejects invalid supply metadata before attachment: '+mode,async()=>{
 const app=await fixture((_req,res)=>{const values=headers(4);if(mode==='too-large')values['content-length']=String(4*1024**3+1);if(mode==='no-length')delete values['content-length'];if(mode==='private-filename')values['content-disposition']='attachment; filename="/private/config.tar.gz"';if(mode==='wrong-type')values['content-type']='text/html';res.writeHead(200,values);res.end(Buffer.alloc(4));});
 try{const response=await fetch(app.url);assert.equal(response.status,502);assert.equal(response.headers.get('content-disposition'),null);assert.doesNotMatch(await response.text(),/private\/config/);}finally{await app.close();}
});
test('Encoded supply suffix and trailing slash still use the streaming route',async()=>{
 const bytes=Buffer.from([31,139,8,0]);const app=await fixture((req,res)=>{assert.equal(req.url,route);res.writeHead(200,headers(bytes.length));res.end(bytes);});try{const response=await fetch(app.base+route.replace('/supply','/%73upply/'));assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);}finally{await app.close();}
});
test('Canonical asset document preserves exact UTF-8 bytes through Gateway without parsing JSON',async()=>{
 const bytes=Buffer.from('{\r\n  "z": "Япония",\r\n  "a": 1\r\n}\r\n','utf8'),assetRoute=route.replace('/supply','/asset');
 const app=await fixture((req,res)=>{assert.equal(req.url,assetRoute);res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':bytes.length});res.end(bytes);});
 try{const response=await fetch(app.base+assetRoute.replace('/asset','/%61sset/'));assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(response.headers.get('cache-control'),'no-store');}finally{await app.close();}
});
