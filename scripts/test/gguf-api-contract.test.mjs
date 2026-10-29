import test from 'node:test';
import assert from 'node:assert/strict';
import {ggufImportOperation} from '../openapi/gguf-import.mjs';
import {DEFAULT_GGUF_IMPORT_POLICY} from '../../services/shared/gguf-import-policy.cjs';

const base='/api/models/gguf-imports';
test('GGUF binary upload is octet-stream only with durable receipt and transport failures',()=>{
    const operation=ggufImportOperation('PUT',base+'/{id}/content');
    assert.deepEqual(Object.keys(operation.requestBody.content),['application/octet-stream']);
    assert.equal(operation.requestBody.content['application/octet-stream'].schema.format,'binary');
    for(const status of [200,400,401,403,409,413,415,502,503,504,507])assert.ok(operation.responses[status]);
    assert.equal(operation.parameters.find(item=>item.name==='content-length').required,false);
    assert.match(operation.description,/No JSON\/base64/);
    assert.match(operation.description,/receipt.bytes/);
});
test('GGUF creation documents actual intent, server SHA and dynamic limits without an immutable 64GiB maximum',()=>{
    const operation=ggufImportOperation('post',base),request=operation.requestBody.content['application/json'].schema;
    assert.deepEqual(request.required,['requestKey','fileName','bytes']);
    assert.equal(request.additionalProperties,false);
    assert.equal(request.properties.expectedSha256.pattern,'^[a-f0-9]{64}$');
    assert.equal(request.properties.fileName['x-neurocenter-utf8-byte-limit'],240);
    assert.equal(request.properties.fileName.maxLength,undefined);
    assert.notEqual(request.properties.bytes.maximum,64*1024**3);
    assert.match(operation.description,/before new-admission flag\/policy/);
    const schema=operation.responses[201].content['application/json'].schema;
    assert.deepEqual(Object.keys(schema.properties.limits.properties),Object.keys(DEFAULT_GGUF_IMPORT_POLICY));
    assert.equal(schema.properties.state.enum.includes('ACCEPTED'),true);
});
test('GGUF acceptance separates file identity, model pin and actual runtime manifest',()=>{
    const operation=ggufImportOperation('post',base+'/{id}/accept'),body=operation.requestBody.content['application/json'].schema;
    assert.deepEqual(body.required,['name','capability']);
    assert.deepEqual(body.properties.capability.enum,['chat','embedding']);
    assert.match(operation.description,/manifestSha256 remains null/);
    assert.match(operation.description,/GGUF SHA is never substituted/);
    assert.match(operation.description,/exact replay/i);
    const model=operation.responses[201].content['application/json'].schema;
    assert.equal(model.properties.runtime.const,'ollama');
    assert.equal(model.properties.fileImport.properties.format.const,'gguf');
    assert.ok(model.properties.manifestSha256.anyOf.some(item=>item.type==='null'));
});
test('GGUF read/cancel/limits contracts preserve OFF and actor ownership',()=>{
    for(const [method,path]of[['get',base+'/{id}'],['get',base+'/requests/{key}'],['delete',base+'/{id}'],['get',base+'/limits']]){
        const operation=ggufImportOperation(method,path);assert.equal(operation.requestBody,undefined);assert.ok(operation.responses[200]);
        assert.deepEqual(operation.security,[{sessionCookie:[]}]);assert.ok(operation.responses[401]);assert.ok(operation.responses[403]);
        if(!path.endsWith('/limits'))assert.match(operation.description,/OFF/);
    }
    const policy=ggufImportOperation('get',base+'/limits').responses[200].content['application/json'].schema;
    assert.deepEqual(policy.required,Object.keys(DEFAULT_GGUF_IMPORT_POLICY));
});
test('GGUF override does not claim unsupported routes or methods',()=>{
    for(const [method,path]of[['post',base+'/{id}/content'],['patch',base+'/{id}'],['get','/api/models/{id}'],['post','/api/models/import-opencode']])assert.equal(ggufImportOperation(method,path),undefined);
});
