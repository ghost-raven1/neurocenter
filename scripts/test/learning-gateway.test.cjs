const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {ProxyService}=require(path.join(process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist'),'proxy/proxy.service.js'));
function fixture(device=true){
 const calls=[],sections=[],headers={};
 const actor={email:'qa@fixture.test',activeRole:'Разработчик',userId:'qa',policies:{},...(device?{deviceId:'device-fixture'}:{})};
 const proxy=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?'http://catalog.fixture':undefined},{authenticate:async()=>actor},{bridge(){},sections:value=>sections.push(value),mutation(){}});
 proxy.http={post:async(...args)=>{calls.push(args);return {status:200,data:args[0].endsWith('/authorize')?{allowed:true,claims:{email:actor.email,userRoles:['Разработчик'],projects:[],pluginIds:[],skillPaths:[]}}:{schemaVersion:1}};},
  request:async options=>{calls.push(options);return {status:200,data:{ok:true},headers:{'content-type':'application/json'}};}};
 const response={code:0,body:null,status(value){this.code=value;return this;},json(value){this.body=value;return this;},send(value){this.body=value;return this;},setHeader(name,value){headers[name.toLowerCase()]=value;}};
 const request=(route,method='POST')=>({path:route,method,headers:{authorization:'Bearer fixture','x-neurocenter-device-id':'forged','x-bridge-actor':'forged'},body:{projectId:'prj-fixture',bindingId:'a'.repeat(64)},query:{}});
 return {proxy,calls,sections,headers,response,request};
}
for(const suffix of ['context','record','propose','observe'])test('Device learning has only the explicit '+suffix+' channel',async()=>{
 const f=fixture(),req=f.request('/api/device-channel/learning/'+suffix);await f.proxy.forward(req,f.response);
 assert.equal(f.response.code,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'http://catalog.fixture/internal/device-channel/learning/'+suffix);
 assert.deepEqual(f.calls[0][1],req.body);assert.equal(f.calls[0][2].headers.authorization,'Bearer fixture');assert.equal(f.calls[0][2].headers['x-neurocenter-device-id'],undefined);
 assert.equal(f.sections.length,suffix==='context'?0:1);
});
test('Device tokens cannot read unapproved browser learning records through generic project GET',async()=>{
 for(const route of ['/api/projects/prj-fixture/learning','/api/projects/prj-fixture/learning/experiences','/api/projects/prj-fixture/%6cearning/analyses/11111111-1111-4111-8111-111111111111','/api/projects/prj-fixture/learning%2fcontext']){
  const f=fixture();await f.proxy.forward(f.request(route,'GET'),f.response);assert.equal(f.response.code,403);assert.equal(f.calls.length,0);
 }
});
test('Unknown actions, nested channels, GET and browser cookies cannot expand the device route',async()=>{
 for(const [route,method] of [['/api/device-channel/learning/approve','POST'],['/api/device-channel/learning/record/extra','POST'],['/api/device-channel/learning/context','GET'],['/api/device-channel/learning/observe','DELETE']]){
  const f=fixture();await f.proxy.forward(f.request(route,method),f.response);assert.equal(f.response.code,404);assert.equal(f.calls.length,0);
 }
 const f=fixture(false);await f.proxy.forward(f.request('/api/device-channel/learning/record'),f.response);assert.equal(f.response.code,401);assert.equal(f.calls.length,0);
});
test('Browser learning replies are private and client-supplied device identity is stripped',async()=>{
 const f=fixture(false),req=f.request('/api/projects/prj-fixture/learning','GET');delete req.headers.authorization;await f.proxy.forward(req,f.response);
 assert.equal(f.response.code,200);assert.equal(f.headers['cache-control'],'no-store');assert.equal(f.calls.length,2);
 const forwarded=f.calls[1];assert.equal(forwarded.headers['x-neurocenter-device-id'],undefined);assert.deepEqual(JSON.parse(decodeURIComponent(forwarded.headers['x-bridge-actor'])),{email:'qa@fixture.test',activeRole:'Разработчик'});
});
