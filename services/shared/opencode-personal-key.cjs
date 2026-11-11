/** Explicit personal-key transfer metadata. Credentials are never valid public contract fields. */
const OPENCODE_PERSONAL_KEY_JOB = 'open-opencode-personal-key';
const OPENCODE_PERSONAL_KEY_CAPABILITY = 'opencode-personal-key-v1';
const OPENCODE_PERSONAL_KEY_VERSION = '1.14.48';
/** OpenCode built-in provider endpoint; the transfer slice resolves local providers by this address. */
const OPENCODE_PERSONAL_KEY_PROVIDER_URL = 'https://api.openai.com/v1';
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
/** Recipient endpoints are https only, never carry credentials or query data, and compare in one canonical form. */
function normalizeOpenCodePersonalKeyProviderUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) fail();
    let url;
    try {
        url = new URL(value);
    } catch {
        fail();
    }
    if (
        url.protocol !== 'https:' ||
        !url.hostname ||
        /[\s\x00-\x1f\x7f]/.test(url.hostname) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
    )
        fail();
    const normalized =
        'https://' + url.hostname + (url.port && url.port !== '443' ? ':' + url.port : '') + url.pathname.replace(/\/+$/, '');
    if (normalized.length > 2048) fail();
    return normalized;
}
const timestamp = (value) =>
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
const fail = () => {
    throw Error('Некорректный контракт переноса личного ключа OpenCode.');
};
function exact(value, keys) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key))
    )
        fail();
}
function target(value) {
    if (
        typeof value.modelId !== 'string' ||
        !value.modelId ||
        value.modelId.length > 240 ||
        typeof value.providerId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.providerId) ||
        !Number.isSafeInteger(value.expectedConnectionRevision) ||
        value.expectedConnectionRevision < 1 ||
        !Number.isSafeInteger(value.expectedCredentialRevision) ||
        value.expectedCredentialRevision < 0
    )
        fail();
}
const targetKeys = ['modelId', 'providerId', 'expectedConnectionRevision', 'expectedCredentialRevision'];
function normalizeOpenCodePersonalKeyRequest(value) {
    exact(value, ['kind', 'deviceId', 'scope', 'requestKey', ...targetKeys]);
    target(value);
    if (
        value.kind !== OPENCODE_PERSONAL_KEY_JOB ||
        value.scope !== 'global' ||
        !uuid(value.deviceId) ||
        !uuid(value.requestKey)
    )
        fail();
    return { ...value };
}
function normalizeOpenCodePersonalKeyPayload(value) {
    exact(value, ['schemaVersion', 'scope', 'deviceId', 'requestKey', 'expiresAt', ...targetKeys]);
    target(value);
    if (
        value.schemaVersion !== 1 ||
        value.scope !== 'global' ||
        !uuid(value.deviceId) ||
        !uuid(value.requestKey) ||
        !timestamp(value.expiresAt)
    )
        fail();
    return { ...value };
}
function normalizeOpenCodePersonalKeyResult(value, expected) {
    exact(value, ['schemaVersion', 'scope', 'deviceId', 'jobId', 'kind', 'checkedAt', 'status', 'expiresAt', 'issue']);
    if (
        value.schemaVersion !== 1 ||
        value.scope !== 'global' ||
        value.kind !== OPENCODE_PERSONAL_KEY_JOB ||
        !uuid(value.deviceId) ||
        !uuid(value.jobId) ||
        !timestamp(value.checkedAt)
    )
        fail();
    if (value.status === 'opened') {
        if (!timestamp(value.expiresAt) || value.issue !== undefined) fail();
    } else if (value.status === 'failed') {
        if (
            ![
                'unsupported-version',
                'source-changed',
                'permission-denied',
                'session-unavailable',
                'cancelled',
                'unknown',
            ].includes(value.issue) ||
            value.expiresAt !== undefined
        )
            fail();
    } else fail();
    if (expected && ['deviceId', 'jobId', 'kind'].some((key) => value[key] !== expected[key])) fail();
    if (
        expected &&
        expected.expiresAt !== undefined &&
        value.status === 'opened' &&
        value.expiresAt !== expected.expiresAt
    )
        fail();
    return { ...value };
}
function normalizeOpenCodePersonalKeyReceipt(value) {
    exact(value, [
        'schemaVersion',
        'jobId',
        'modelId',
        'providerId',
        'requestKey',
        'connectionRevision',
        'credentialRevision',
        'hasKey',
        'acceptedAt',
    ]);
    if (
        value.schemaVersion !== 1 ||
        !uuid(value.jobId) ||
        !uuid(value.requestKey) ||
        typeof value.modelId !== 'string' ||
        !value.modelId ||
        typeof value.providerId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.providerId) ||
        !Number.isSafeInteger(value.connectionRevision) ||
        value.connectionRevision < 1 ||
        !Number.isSafeInteger(value.credentialRevision) ||
        value.credentialRevision < 1 ||
        value.hasKey !== true ||
        !timestamp(value.acceptedAt)
    )
        fail();
    return { ...value };
}
function normalizeOpenCodePersonalKeyContext(value) {
    exact(value, ['ok', 'expiresAt', 'requestKey', 'recipient']);
    if (value.ok !== true || !timestamp(value.expiresAt) || !uuid(value.requestKey)) fail();
    const r = value.recipient;
    exact(r, [
        'ownerEmail',
        'modelId',
        'modelName',
        'providerId',
        'providerUrl',
        'connectionRevision',
        'credentialRevision',
        'authMode',
        'canStoreKey',
    ]);
    target({
        modelId: r.modelId,
        providerId: r.providerId,
        expectedConnectionRevision: r.connectionRevision,
        expectedCredentialRevision: r.credentialRevision,
    });
    if (
        typeof r.ownerEmail !== 'string' ||
        !r.ownerEmail ||
        r.ownerEmail.length > 320 ||
        typeof r.modelName !== 'string' ||
        !r.modelName ||
        r.modelName.length > 500 ||
        normalizeOpenCodePersonalKeyProviderUrl(r.providerUrl) !== r.providerUrl ||
        !['optional', 'required'].includes(r.authMode) ||
        r.canStoreKey !== true
    )
        fail();
    return { ...value, recipient: { ...r } };
}
const string = { type: 'string' },
    idSchema = { type: 'string', format: 'uuid' },
    dateSchema = { type: 'string', format: 'date-time' },
    providerSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' },
    positive = { type: 'integer', minimum: 1 },
    nonnegative = { type: 'integer', minimum: 0 };
const schema = (properties) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});
const targetSchema = {
    modelId: { type: 'string', minLength: 1, maxLength: 240 },
    providerId: providerSchema,
    expectedConnectionRevision: positive,
    expectedCredentialRevision: nonnegative,
};
const payloadSchema = {
    schemaVersion: { type: 'integer', enum: [1] },
    scope: { enum: ['global'] },
    deviceId: idSchema,
    requestKey: idSchema,
    ...targetSchema,
    expiresAt: dateSchema,
};
const identitySchema = {
    schemaVersion: { type: 'integer', enum: [1] },
    scope: { enum: ['global'] },
    deviceId: idSchema,
    jobId: idSchema,
    kind: { enum: [OPENCODE_PERSONAL_KEY_JOB] },
    checkedAt: dateSchema,
};
const OPENCODE_PERSONAL_KEY_SCHEMAS = Object.freeze({
    request: schema({
        kind: { enum: [OPENCODE_PERSONAL_KEY_JOB] },
        scope: { enum: ['global'] },
        deviceId: idSchema,
        requestKey: idSchema,
        ...targetSchema,
    }),
    payload: schema(payloadSchema),
    result: {
        oneOf: [
            schema({ ...identitySchema, status: { enum: ['opened'] }, expiresAt: dateSchema }),
            schema({
                ...identitySchema,
                status: { enum: ['failed'] },
                issue: {
                    enum: [
                        'unsupported-version',
                        'source-changed',
                        'permission-denied',
                        'session-unavailable',
                        'cancelled',
                        'unknown',
                    ],
                },
            }),
        ],
    },
    receipt: schema({
        schemaVersion: { type: 'integer', enum: [1] },
        jobId: idSchema,
        requestKey: idSchema,
        modelId: targetSchema.modelId,
        providerId: providerSchema,
        connectionRevision: positive,
        credentialRevision: positive,
        hasKey: { enum: [true] },
        acceptedAt: dateSchema,
    }),
    context: schema({
        ok: { enum: [true] },
        expiresAt: dateSchema,
        requestKey: idSchema,
        recipient: schema({
            ownerEmail: { ...string, minLength: 1, maxLength: 320 },
            modelId: targetSchema.modelId,
            modelName: { ...string, minLength: 1, maxLength: 500 },
            providerId: providerSchema,
            providerUrl: {
                type: 'string',
                minLength: 9,
                maxLength: 2048,
                pattern: '^https://[a-zA-Z0-9.\\[\\]:-]+(?::\\d+)?(?:/\\S*)*$',
            },
            connectionRevision: positive,
            credentialRevision: nonnegative,
            authMode: { enum: ['optional', 'required'] },
            canStoreKey: { enum: [true] },
        }),
    }),
});
module.exports = {
    OPENCODE_PERSONAL_KEY_SCHEMAS,
    OPENCODE_PERSONAL_KEY_JOB,
    OPENCODE_PERSONAL_KEY_CAPABILITY,
    OPENCODE_PERSONAL_KEY_VERSION,
    OPENCODE_PERSONAL_KEY_PROVIDER_URL,
    normalizeOpenCodePersonalKeyProviderUrl,
    normalizeOpenCodePersonalKeyRequest,
    normalizeOpenCodePersonalKeyPayload,
    normalizeOpenCodePersonalKeyResult,
    normalizeOpenCodePersonalKeyReceipt,
    normalizeOpenCodePersonalKeyContext,
};
