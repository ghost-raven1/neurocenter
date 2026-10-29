import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeRemoteProviderAccess,PERSONAL_PROVIDER_SCHEMAS} from '../openapi/remote-provider-access.mjs';
const operation=()=>({security:[{sessionCookie:[]}],responses:{'200':{description:'Successful response'}}});

test('personal access schemas have exact owner-free identities and a write-only key',()=>{
    const {save,remove,view,receipt}=PERSONAL_PROVIDER_SCHEMAS;
    assert.equal(save.additionalProperties,false);assert.equal(remove.additionalProperties,false);
    assert.equal(save.properties.apiKey.writeOnly,true);assert.equal(save.properties.apiKey.maxLength,8192);
    assert.deepEqual(Object.keys(save.properties).sort(),['apiKey','expectedConnectionRevision','expectedCredentialRevision','providerId','requestKey']);
    assert.deepEqual(remove.required,['providerId','expectedConnectionRevision','expectedCredentialRevision','requestKey']);
    for(const read of [view,receipt])assert.ok(!Object.hasOwn(read.properties,'apiKey'));
    assert.deepEqual(view.properties.authMode.enum,['none','optional','required']);
});
test('masked receipts remain nullable browser GETs and explain uncertain commit without automatic replay',()=>{
    const read=describeRemoteProviderAccess(operation(),'/api/models/{id}/my-access/requests/{key}','get');
    assert.deepEqual(read.security,[{sessionCookie:[]}]);assert.equal(read.responses['200'].content['application/json'].schema.nullable,true);
    assert.match(read.description,/null does not prove/);assert.match(read.description,/403 after COMMIT/);assert.match(read.description,/remain readable when the feature is OFF/);
    assert.equal(read.requestBody,undefined);
    for(const [http,schema]of [['put',PERSONAL_PROVIDER_SCHEMAS.save],['delete',PERSONAL_PROVIDER_SCHEMAS.remove]]){
        const write=describeRemoteProviderAccess(operation(),'/api/models/{id}/my-access',http);
        assert.equal(write.requestBody.content['application/json'].schema,schema);assert.ok(write.responses['409']);
        assert.match(write.description,/No shared administrator\/environment credential fallback/);
    }
});
test('provider setup removes shared key writes while retaining anonymous input compatibility',()=>{
    const op=operation();op.requestBody={content:{'application/json':{schema:{type:'object',properties:{apiKey:{type:'string'},credentialEnv:{type:'string'},credential:{type:'string'},authMode:{type:'string'},options:{type:'object'}},required:['credential']}}}};
    const schema=describeRemoteProviderAccess(op,'/api/models/{id}/connection','put').requestBody.content['application/json'].schema;
    assert.ok(!Object.hasOwn(schema.properties,'apiKey'));assert.ok(!Object.hasOwn(schema.properties,'credentialEnv'));
    assert.deepEqual(schema.properties.authMode.enum,['none','optional','required']);assert.deepEqual(schema.properties.credential.enum,['none']);
    assert.deepEqual(schema.anyOf,[{required:['authMode']},{required:['credential']}]);assert.equal(schema.additionalProperties,false);
    const other=operation();assert.equal(describeRemoteProviderAccess(other,'/internal/models/a/my-access','get'),other);
});
