const {test}=require('node:test');
const assert=require('node:assert/strict');
const {checkReadiness,httpReady}=require('../../services/shared/readiness.cjs');
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
