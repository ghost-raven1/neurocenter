const {test}=require('node:test');
const assert=require('node:assert/strict');
const {checkReadiness,httpReady}=require('../../services/shared/readiness.cjs');

test('HTTP readiness requires a bounded JSON success receipt, not an arbitrary HTTP200',async()=>{
    const previous=global.fetch;
    try{
        for(const body of ['<html>proxy error</html>','{}','{"ok":false}','{"ok":"true"}','x'.repeat(16385)]){
            global.fetch=async()=>new Response(body,{status:200});
            await assert.rejects(httpReady('http://dependency.test/'));
        }
        global.fetch=async(url,options)=>{assert.equal(url,'http://dependency.test/ready');assert.equal(options.redirect,'error');return Response.json({ok:true});};
        await httpReady('http://dependency.test/');
    }finally{global.fetch=previous;}
});
test('Readiness показывает независимые исправные зависимости',async()=>{
    assert.deepEqual(await checkReadiness({database:async()=>{},files:async()=>{}}),{ok:true,checks:{database:'ready',files:'ready'}});
});
test('Сбой зависимости даёт отказ и не раскрывает строку подключения',async()=>{
    const state=await checkReadiness({database:async()=>{throw new Error('postgresql://secret');},files:async()=>{}});
    assert.equal(state.ok,false);assert.equal(state.checks.database,'unavailable');assert.equal(state.checks.files,'ready');assert.ok(!JSON.stringify(state).includes('secret'));
});
test('Зависший вызов ограничен по времени',async()=>{
    const before=Date.now();const state=await checkReadiness({database:()=>new Promise(()=>{})});assert.equal(state.ok,false);assert.ok(Date.now()-before<4000);
});
test('HTTP readiness не принимает редирект за исправность',async t=>{
    t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'https://dependency.test/ready');assert.equal(options.redirect,'error');return {ok:false};});
    await assert.rejects(httpReady('https://dependency.test/'));
});
