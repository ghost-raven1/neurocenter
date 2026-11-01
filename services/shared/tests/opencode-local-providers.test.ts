import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../opencode-local-providers.cjs') as typeof import('../opencode-local-providers.cjs');
const { requiredJobFeatures } = require('../feature-policy.cjs') as typeof import('../feature-policy.cjs');
const {
    OPENCODE_V2_ACCOUNTS_ADAPTER: adapter,
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB: read,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB: open,
} = contract;
const deviceId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const accountInventory = {
    accounts: [{ integrationId: 'anthropic', hasApiKey: true, hasOAuth: false, hasExternal: false }],
    issues: [],
};
const identity = {
    schemaVersion: 1,
    scope: 'global',
    deviceId,
    jobId,
    kind: read,
    checkedAt: '2026-11-01T00:00:00.000Z',
};

test('V2 stored accounts bind to the requested adapter without claiming effective provider configuration', () => {
    const value = { ...identity, adapter, status: 'checked', accountInventory };
    assert.deepEqual(contract.normalizeGlobalProvidersResult(value, { deviceId, jobId, kind: read, adapter }), value);
    assert.throws(() => contract.normalizeGlobalProvidersResult(value, { deviceId, jobId, kind: read }));
    assert.throws(() => contract.normalizeGlobalProvidersResult({ ...value, inventory: {} }));
    assert.throws(() => contract.normalizeGlobalProvidersResult({ ...value, adapter: undefined }));
});
test('legacy requests and results remain valid and cannot satisfy a V2 request', () => {
    const request = { deviceId, kind: read, scope: 'global', requestKey: jobId };
    assert.deepEqual(contract.normalizeGlobalProvidersRequest(request), request);
    const value = {
        ...identity,
        status: 'checked',
        inventory: {
            providers: [],
            configurationFound: false,
            authenticationFound: false,
            overrideDetected: false,
            issues: [],
        },
    };
    assert.deepEqual(contract.normalizeGlobalProvidersResult(value, { deviceId, jobId, kind: read }), value);
    assert.throws(() => contract.normalizeGlobalProvidersResult(value, { deviceId, jobId, kind: read, adapter }));
});
test('request and payload allow only the explicit adapter, not arbitrary versions or server addresses', () => {
    const request = { deviceId, kind: read, scope: 'global', requestKey: jobId, adapter };
    assert.deepEqual(contract.normalizeGlobalProvidersRequest(request), request);
    for (const extra of [
        { adapter: '2.x' },
        { serverUrl: 'http://127.0.0.1:1234' },
        { password: 'synthetic-private' },
    ]) {
        assert.throws(() => contract.normalizeGlobalProvidersRequest({ ...request, ...extra }));
        assert.throws(() =>
            contract.normalizeGlobalProvidersPayload(
                { schemaVersion: 1, scope: 'global', deviceId, adapter, ...extra },
                read,
            ),
        );
    }
});
test('public inventory rejects account identifiers, labels, credentials and derived hashes', () => {
    for (const key of ['id', 'label', 'key', 'value', 'password', 'sha256', 'active', 'endpoint']) {
        assert.throws(() =>
            contract.normalizeOpenCodeAccountInventory({
                ...accountInventory,
                accounts: [{ ...accountInventory.accounts[0], [key]: 'synthetic-private' }],
            }),
        );
    }
    assert.throws(() => contract.normalizeOpenCodeAccountInventory({ ...accountInventory, serverPid: 1 }));
    assert.throws(() =>
        contract.normalizeOpenCodeAccountInventory({
            ...accountInventory,
            accounts: [...accountInventory.accounts, ...accountInventory.accounts],
        }),
    );
});
test('partial results require known issue codes and never relay arbitrary error text', () => {
    const value = {
        ...identity,
        adapter,
        status: 'partial',
        accountInventory: { ...accountInventory, issues: ['source-changed'] },
    };
    assert.deepEqual(contract.normalizeGlobalProvidersResult(value), value);
    assert.throws(() => contract.normalizeGlobalProvidersResult({ ...value, status: 'checked' }));
    assert.throws(() =>
        contract.normalizeGlobalProvidersResult({
            ...value,
            accountInventory: { ...accountInventory, issues: ['secret-in-error'] },
        }),
    );
});
test('V2 opening requires its flag while read and existing recovery remain available without it', () => {
    assert.deepEqual(requiredJobFeatures(open, { adapter }), [
        'computer_setup',
        'computer_connections',
        'opencode_v2_accounts',
    ]);
    assert.deepEqual(requiredJobFeatures(open, { adapter }, true), [
        'computer_setup',
        'computer_connections',
        'opencode_v2_accounts',
    ]);
    assert.deepEqual(requiredJobFeatures(open), ['computer_setup', 'computer_connections']);
    assert.deepEqual(requiredJobFeatures(read, { adapter }), []);
});
