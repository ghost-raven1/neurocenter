import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeRuntimeLimits,RUNTIME_LIMIT_SCHEMAS} from '../openapi/runtime-limits.mjs';
import {DEFAULT_RUNTIME_LIMIT_POLICY,RUNTIME_LIMIT_CEILINGS} from '../../services/shared/runtime-limits.cjs';
const operation=()=>({security:[{sessionCookie:[]}],responses:{'200':{description:'Successful response'}}});
test('runtime policy schema describes every shared bounded field without unknown objects',()=>{
    const schema=RUNTIME_LIMIT_SCHEMAS.policy;assert.equal(schema.additionalProperties,false);
    for(const group of Object.keys(DEFAULT_RUNTIME_LIMIT_POLICY)){
        assert.deepEqual(schema.properties[group].required,Object.keys(DEFAULT_RUNTIME_LIMIT_POLICY[group]));
        for(const [key,value]of Object.entries(RUNTIME_LIMIT_CEILINGS[group]))assert.equal(schema.properties[group].properties[key].maximum,value);
    }
});
test('effective and admin reads distinguish safe public numbers from browser MainAdmin configuration',()=>{
    const read=describeRuntimeLimits(operation(),'/api/runtime-limits','get');
    assert.equal(read.responses['200'].content['application/json'].schema,RUNTIME_LIMIT_SCHEMAS.view);
    assert.match(read.description,/sanitized effective policy/);assert.match(read.description,/retain their admission snapshot/);
    const admin=describeRuntimeLimits(operation(),'/api/runtime-limits/admin','get');
    assert.deepEqual(admin.security,[{sessionCookie:[]}]);assert.equal(admin.responses['200'].content['application/json'].schema,RUNTIME_LIMIT_SCHEMAS.admin);
});
test('CAS saves and own receipts document exact replay, OFF recovery and unconfirmed outcome',()=>{
    const save=describeRuntimeLimits(operation(),'/api/runtime-limits/admin','patch');
    assert.equal(save.requestBody.content['application/json'].schema,RUNTIME_LIMIT_SCHEMAS.input);
    assert.deepEqual(RUNTIME_LIMIT_SCHEMAS.input.required,['expectedRevision','requestKey','policy']);
    assert.match(save.description,/before new-save feature checks/);assert.match(save.description,/missing receipt does not prove/);assert.ok(save.responses['409']);assert.ok(save.responses['503']);
    const receipt=describeRuntimeLimits(operation(),'/api/runtime-limits/admin/requests/{key}','get');
    assert.equal(receipt.responses['200'].content['application/json'].schema,RUNTIME_LIMIT_SCHEMAS.receipt);
    const internal=operation();assert.equal(describeRuntimeLimits(internal,'/internal/runtime-limits','get'),internal);
});
