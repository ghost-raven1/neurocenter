const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {once}=require('node:events');
const {createRequire}=require('node:module');
const path=require('node:path');
const gatewayRequire=createRequire(path.resolve('services/api-gateway/package.json'));
const bridgeRequire=createRequire(path.resolve('mcp/neurocenter-asset-sync/package.json'));
const express=gatewayRequire('express'),{Server}=gatewayRequire('socket.io'),{io}=bridgeRequire('socket.io-client');
const dist=path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist');
const {ProxyService}=require(path.join(dist,'proxy/proxy.service.js')),{LiveService}=require(path.join(dist,'live/live.service.js'));
const email='qa-wake@example.test',deviceId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const route='/api/projects/prj-wake-qa/agents/connect';
const job={id:jobId,deviceId,projectId:'prj-wake-qa',kind:'configure-project-agents',state:'queued',desiredRevision:3};

test('Exact agent connect wakes only its validated device and invalidates catalog without private prompt bytes',()=>{
 const events=[],live=new LiveService();live.attach({to:room=>({emit:(event,payload)=>events.push({room,event,payload})}),emit:(event,payload)=>events.push({event,payload})});
 live.mutation(route,email,{...job,prompt:'PRIVATE_PROMPT',token:'PRIVATE_TOKEN'},'POST');
 assert.deepEqual(events.filter(event=>event.room),[{room:'user:'+email,event:'bridge:changed',payload:{deviceId,jobId}},{room:'device:'+deviceId,event:'bridge:work',payload:undefined}]);
 assert.deepEqual(events.find(event=>event.event==='section:changed').payload.sections,['projects','catalog','knowledge','maintenance','operations','audit']);
 assert.doesNotMatch(JSON.stringify(events),/PRIVATE/);
});

for(const [method,pathname,response]of [
 ['PATCH',route,job],['POST',route+'/extra',job],['POST','/api/projects/prj-wake-qa/agents',job],
 ['POST',route,{...job,kind:'other'}],['POST',route,{...job,deviceId:''}],['POST',route,{...job,id:''}],['POST',route,{desiredRevision:3}],
])test('No unrelated wake: '+method+' '+pathname+' '+JSON.stringify(response),()=>{
 const events=[],live=new LiveService();live.attach({to:room=>({emit:event=>events.push({room,event})}),emit(){}});live.mutation(pathname,email,response,method);assert.deepEqual(events,[]);
});

/** A polling-free worker cannot receive this job unless the real HTTP Gateway emits an actual Socket.io wake. */
test('Actual HTTP Gateway connect -> Socket.io wake -> immediate HTTP claim without polling',async()=>{
 let queued=null,claimedAt=null,wokeAt=null,requests=[];
 const upstream=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(req.url);
  res.writeHead(200,{'content-type':'application/json'});
  if(req.url==='/internal/access/authorize'){res.end(JSON.stringify({allowed:true,claims:{email,userRoles:['Главный админ'],projects:[],pluginIds:[],skillPaths:[]}}));return;}
  if(req.url===route){queued={...job};res.end(JSON.stringify(job));return;}
  if(req.url==='/internal/device-channel/jobs/claim'){claimedAt=Date.now();const result=queued;queued=null;res.end(JSON.stringify(result));return;}
  res.end('{}');
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const live=new LiveService(),proxy=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?`http://127.0.0.1:${upstream.address().port}`:undefined},{authenticate:async req=>({email,activeRole:'Главный админ',...(req.headers.authorization?{deviceId}:{})})},live);
 const app=express();app.use(express.json());app.use((req,res,next)=>{void proxy.forward(req,res).catch(next);});
 const gateway=createServer(app),sockets=new Server(gateway,{serveClient:false});live.attach(sockets);sockets.on('connection',socket=>socket.join('device:'+deviceId));gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 const base=`http://127.0.0.1:${gateway.address().port}`,worker=io(base,{transports:['websocket'],reconnection:false});
 try{
  await once(worker,'connect');let deadline;
  const claim=new Promise((resolve,reject)=>{deadline=setTimeout(()=>reject(Error('Worker received no wake; polling deliberately disabled')),2000);worker.once('bridge:work',async()=>{wokeAt=Date.now();try{const response=await fetch(base+'/api/device-channel/jobs/claim',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:'{}'});resolve(await response.json());}catch(error){reject(error);}});});
  const start=Date.now(),response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId,expectedRevision:3,requestKey:'fixture'})});assert.equal(response.status,200);assert.deepEqual(await response.json(),job);
  try{assert.deepEqual(await claim,job);}finally{clearTimeout(deadline);}
  assert.ok(wokeAt>=start&&claimedAt>=wokeAt&&claimedAt-start<2000);assert.equal(queued,null);assert.ok(requests.includes('/internal/device-channel/jobs/claim'));
 }finally{worker.disconnect();await new Promise(resolve=>sockets.close(resolve));upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
});
