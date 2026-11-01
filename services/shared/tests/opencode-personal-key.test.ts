import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const contract = require('../opencode-personal-key.cjs') as typeof import('../opencode-personal-key.cjs');
const { requiredJobFeatures, requiredRouteFeatures } = require('../feature-policy.cjs');
const deviceId = '11111111-1111-4111-8111-111111111111',
    jobId = '22222222-2222-4222-8222-222222222222';
const request = {
    kind: contract.OPENCODE_PERSONAL_KEY_JOB,
    scope: 'global',
    deviceId,
    modelId: 'openai-test',
    providerId: 'a'.repeat(64),
    expectedConnectionRevision: 1,
    expectedCredentialRevision: 0,
    requestKey: jobId,
};
test('public transfer request binds the recipient and refuses key/owner/endpoint injection', () => {
    assert.deepEqual(contract.normalizeOpenCodePersonalKeyRequest(request), request);
    for (const extra of [
        { apiKey: 'private' },
        { ownerEmail: 'other@example.test' },
        { providerUrl: 'https://other.example' },
    ])
        assert.throws(() => contract.normalizeOpenCodePersonalKeyRequest({ ...request, ...extra }));
});
test('opened receipts support generic identity validation and exact expiry when known', () => {
    const result = {
        schemaVersion: 1,
        scope: 'global',
        deviceId,
        jobId,
        kind: request.kind,
        checkedAt: '2026-11-01T00:00:00.000Z',
        status: 'opened',
        expiresAt: '2026-11-01T00:15:00.000Z',
    };
    assert.deepEqual(
        contract.normalizeOpenCodePersonalKeyResult(result, { deviceId, jobId, kind: request.kind }),
        result,
    );
    assert.deepEqual(
        contract.normalizeOpenCodePersonalKeyResult(result, {
            deviceId,
            jobId,
            kind: request.kind,
            expiresAt: result.expiresAt,
        }),
        result,
    );
    assert.throws(() =>
        contract.normalizeOpenCodePersonalKeyResult(result, {
            deviceId,
            jobId,
            kind: request.kind,
            expiresAt: '2026-11-01T00:30:00.000Z',
        }),
    );
});
test('transfer public receipts reject raw credentials, provenance and credential-derived hashes', () => {
    const result = {
        schemaVersion: 1,
        jobId,
        requestKey: jobId,
        modelId: request.modelId,
        providerId: request.providerId,
        connectionRevision: 1,
        credentialRevision: 1,
        hasKey: true,
        acceptedAt: '2026-11-01T00:00:00.000Z',
    };
    assert.deepEqual(contract.normalizeOpenCodePersonalKeyReceipt(result), result);
    for (const field of ['apiKey', 'requestHash', 'transferJobId', 'credential'])
        assert.throws(() => contract.normalizeOpenCodePersonalKeyReceipt({ ...result, [field]: 'private' }));
});
test('new transfer admission requires its own flag while accepted receipt reads stay ungated', () => {
    assert.ok(requiredJobFeatures(request.kind).includes('opencode_personal_key_transfer'));
    assert.deepEqual(requiredRouteFeatures('GET', '/api/models/openai-test/my-access/transfers/' + jobId), []);
});
