const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {setImmediate:tick}=require('node:timers/promises');
const {ProxyService}=require(path.resolve(process.env.GATEWAY_TEST_DIST||'services/api-gateway/dist','proxy/proxy.service.js'));

/** Axios uses its real merged configuration; only transport and time are synthetic. */
function fixture({delay=0,allowed=true,authenticated=true}={}){
    const calls=[];
    const proxy=new ProxyService({get:key=>key==='CATALOG_SERVICE_URL'?'http://catalog.fixture':undefined},
        {authenticate:async()=>authenticated?{userId:'fixture',email:'fixture@example.test',activeRole:'Главный админ',policies:[]}:null},{mutation(){}});
    proxy.http.defaults.adapter=async config=>{
        calls.push(config);
        const response=data=>({status:200,statusText:'OK',data,headers:{'content-type':'application/json'},config});
        if(config.url.endsWith('/internal/access/authorize'))return response({allowed,claims:{projects:[],pluginIds:[],skillPaths:[]}});
        if(config.url.endsWith('/internal/feature-flags/evaluated'))return response({flags:{tool_builds:true,model_hosting:true,rag_sync:true}});
        return new Promise((resolve,reject)=>{
            const deadline=setTimeout(()=>{clearTimeout(reply);reject(Object.assign(new Error('fixture timeout'),{code:'ECONNABORTED'}));},config.timeout);
            const reply=setTimeout(()=>{clearTimeout(deadline);resolve(response({entrypoint:'SKILL.md',recommendedKind:'skill'}));},delay);
        });
    };
    const response={statusCode:0,writes:0,status(code){this.statusCode=code;return this;},json(value){this.body=value;this.writes++;return this;},send(value){this.body=value;this.writes++;return this;},setHeader(){}};
    return {proxy,calls,response,request:(resource,method='GET')=>({path:resource,method,headers:{},query:{url:'https://github.com/fixture/skill'},body:undefined})};
}
for(const resource of ['/api/tool-builds/repository','/api/tool-builds/repository/','/api/tool-builds/%72epository/','/api/tool-builds/npm','/api/tool-builds/npm/']){
    test('Metadata survives the old 30 s deadline: '+resource,async t=>{
        t.mock.timers.enable({apis:['setTimeout']});
        const f=fixture({delay:35000}),work=f.proxy.forward(f.request(resource),f.response);
        await tick();
        assert.equal(f.calls[0].timeout,30000);
        assert.equal(f.calls.at(-1).timeout,85000);
        t.mock.timers.tick(30001);await tick();assert.equal(f.response.writes,0);
        t.mock.timers.tick(4999);await work;
        assert.equal(f.response.statusCode,200);assert.equal(f.response.body.entrypoint,'SKILL.md');assert.equal(f.response.writes,1);
    });
}
test('Unresponsive metadata is still bounded before the 90 s client deadline',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const f=fixture({delay:100000}),work=f.proxy.forward(f.request('/api/tool-builds/repository'),f.response);
    await tick();t.mock.timers.tick(84999);await tick();assert.equal(f.response.writes,0);
    t.mock.timers.tick(1);await work;
    assert.equal(f.response.statusCode,502);assert.deepEqual(f.response.body,{error:'upstream-unavailable'});assert.equal(f.response.writes,1);
});
for(const [method,resource]of [['POST','/api/tool-builds/repository'],['GET','/api/tool-builds/repository/extra'],['GET','/api/tool-builds/requests/key'],['POST','/api/tool-builds'],['GET','/api/projects'],['GET','/api/tool-builds/%2e%2e/repository']]){
    test('Other routes retain the 30 s bound: '+method+' '+resource,async t=>{
        t.mock.timers.enable({apis:['setTimeout']});
        const f=fixture({delay:35000}),work=f.proxy.forward(f.request(resource,method),f.response);
        await tick();assert.equal(f.calls.at(-1).timeout,30000);
        t.mock.timers.tick(30000);await work;
        assert.equal(f.response.statusCode,502);assert.equal(f.response.writes,1);
    });
}
for(const denied of ['unauthenticated','forbidden'])test('Metadata deadline does not bypass '+denied+' access',async()=>{
    const f=fixture({authenticated:denied!=='unauthenticated',allowed:denied!=='forbidden'});
    await f.proxy.forward(f.request('/api/tool-builds/repository'),f.response);
    assert.equal(f.response.statusCode,denied==='unauthenticated'?401:403);
    assert.equal(f.calls.filter(call=>!call.url.endsWith('/internal/access/authorize')).length,0);
});
