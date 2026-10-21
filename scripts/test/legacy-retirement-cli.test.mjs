import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRetirementArguments,runRetirement} from '../assets/retire-legacy.mjs';
const id='11111111-1111-4111-8111-111111111111',key='22222222-2222-4222-8222-222222222222',digest='a'.repeat(64);
const apply=['apply','--preview-id',id,'--digest',digest,'--request-key',key];
test('Migration CLI accepts only preview or explicit exact apply, never arbitrary target paths/projects',()=>{
    assert.deepEqual(parseRetirementArguments(['preview']),{mode:'preview'});
    assert.equal(parseRetirementArguments(apply).requestKey,key);
    for(const args of [[],['preview','--path','common/user'],['preview','--project-id','prj-user'],['apply'],['preview','--request-key',key],['apply',...apply.slice(1),'--request-key',key]])assert.throws(()=>parseRetirementArguments(args));
});
test('Remote apply uses the operator session and exact CAS only; no source/card or fresh request key is invented',async()=>{
    const calls=[],request=async(url,options)=>{calls.push({url:String(url),options});return Response.json(calls.length===1?{user:{activeRole:'Главный админ'}}:{state:'SUCCEEDED',historyPurged:false});};
    assert.equal((await runRetirement([...apply,'--url','https://example.test'],request,{NEUROCENTER_OPERATOR_COOKIE:'fixture-session'})).state,'SUCCEEDED');
    assert.equal(calls.length,2);assert.equal(calls[1].url,'https://example.test/api/asset-management/legacy-retirement/apply');
    assert.deepEqual(JSON.parse(calls[1].options.body),{previewId:id,expectedDigest:digest,requestKey:key});assert.equal(calls[1].options.redirect,'error');assert.ok(calls[1].options.signal);
});
test('A remote missing session, URL credentials and a non-admin session fail before POST',async()=>{
    let count=0;const request=async()=>{count++;return Response.json({user:{activeRole:'Разработчик'}});};
    await assert.rejects(runRetirement(['preview','--url','https://example.test'],request,{}),/session/);assert.equal(count,0);
    await assert.rejects(runRetirement(['preview','--url','https://user:password@example.test'],request,{}),/credentials/);assert.equal(count,0);
    await assert.rejects(runRetirement(['preview','--url','https://example.test'],request,{NEUROCENTER_OPERATOR_COOKIE:'fixture-session'}),/администратора/);assert.equal(count,1);
});
test('Local operator login is bounded and preview sends an empty target-free body',async()=>{
    const calls=[],request=async(url,options)=>{calls.push({url:String(url),options});if(String(url).endsWith('/auth/login'))return new Response(null,{status:302,headers:{'set-cookie':'fixture=session; HttpOnly'}});return Response.json(String(url).endsWith('/auth/me')?{user:{activeRole:'Главный админ'}}:{policy:'legacy-demo-retirement-v1'});};
    assert.equal((await runRetirement(['preview'],request,{})).policy,'legacy-demo-retirement-v1');assert.equal(calls.length,3);assert.deepEqual(JSON.parse(calls[2].options.body),{});
});
