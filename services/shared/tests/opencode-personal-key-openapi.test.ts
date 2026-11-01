import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePersonalKey } from '../../../scripts/openapi/opencode-personal-key.mjs';
test('direct device write is explicitly write-only and public transfer receipt excludes credential-derived metadata', () => {
    const operation = () => ({ responses: { '200': { description: 'ok' } } });
    const save = describePersonalKey(operation(), '/api/device-channel/opencode-personal-key/save', 'post');
    const schema = save.requestBody.content['application/json'].schema;
    assert.equal(schema.properties.apiKey.writeOnly, true);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['jobId', 'apiKey']);
    const read = describePersonalKey(operation(), '/api/models/{id}/my-access/transfers/{jobId}', 'get');
    const receipt = read.responses['200'].content['application/json'].schema.properties.receipt;
    assert.equal(receipt.nullable, true);
    assert.equal(receipt.additionalProperties, false);
    assert.equal(receipt.properties.apiKey, undefined);
    assert.equal(receipt.properties.requestHash, undefined);
    assert.equal(receipt.properties.transferJobId, undefined);
});
