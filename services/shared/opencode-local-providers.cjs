const OPENCODE_GLOBAL_PROVIDERS_READ_JOB = 'inspect-opencode-global-providers';
const OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB = 'open-opencode-global-providers';
const OPENCODE_GLOBAL_PROVIDERS_CAPABILITY = 'opencode-global-providers-v1';
const OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION = '1.14.48';
const OPENCODE_V2_ACCOUNTS_ADAPTER = 'opencode-v2-accounts';
const OPENCODE_V2_ACCOUNTS_CAPABILITY = 'opencode-v2-accounts-2.2.2';
const OPENCODE_V2_ACCOUNTS_VERSION = '2.2.2';
const kinds = [OPENCODE_GLOBAL_PROVIDERS_READ_JOB, OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB];
const issues = [
    'invalid-json',
    'unsafe-file',
    'source-changed',
    'environment-override',
    'entry-limit',
    'read-failed',
    'permission-denied',
    'cancelled',
    'session-unavailable',
    'unsupported-version',
    'unknown',
];
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const providerId = (value) =>
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
const modelId = (value) =>
    typeof value === 'string' && value.length <= 240 && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(value);
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = () => {
    throw Error('Некорректный контракт локальных провайдеров OpenCode.');
};
function exact(value, names) {
    if (!object(value) || Object.keys(value).some((key) => !names.includes(key))) fail();
}
function normalizeGlobalProvidersRequest(value) {
    exact(value, ['deviceId', 'kind', 'scope', 'requestKey', 'adapter']);
    if (value.adapter !== undefined && value.adapter !== OPENCODE_V2_ACCOUNTS_ADAPTER) fail();
    if (!uuid(value.deviceId) || !uuid(value.requestKey) || !kinds.includes(value.kind) || value.scope !== 'global')
        fail();
    return { ...value };
}
const timestamp = (value) =>
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
function normalizeGlobalProvidersPayload(value, kind) {
    exact(value, ['schemaVersion', 'scope', 'deviceId', 'expiresAt', 'adapter']);
    if (value.adapter !== undefined && value.adapter !== OPENCODE_V2_ACCOUNTS_ADAPTER) fail();
    if (
        value.schemaVersion !== 1 ||
        value.scope !== 'global' ||
        !uuid(value.deviceId) ||
        (kind === OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB && !timestamp(value.expiresAt)) ||
        (kind === OPENCODE_GLOBAL_PROVIDERS_READ_JOB && value.expiresAt !== undefined) ||
        (value.expiresAt !== undefined && !timestamp(value.expiresAt))
    )
        fail();
    return { ...value };
}
const DEFAULT_GLOBAL_PROVIDERS_LIMITS = Object.freeze({
    fileBytes: 1048576,
    providers: 100,
    modelsPerProvider: 200,
    secretBytes: 8192,
    sessionMs: 900000,
    requestBytes: 262144,
    publicBytes: 131072,
    httpRequestMs: 10000,
    httpHeadersMs: 5000,
    httpHeadersCount: 30,
    sessions: 4,
});
const ceilings = {
    fileBytes: 16777216,
    providers: 1000,
    modelsPerProvider: 1000,
    secretBytes: 65536,
    sessionMs: 2147483647,
    requestBytes: 16777216,
    publicBytes: 524288,
    httpRequestMs: 2147483647,
    httpHeadersMs: 2147483647,
    httpHeadersCount: 1000,
    sessions: 32,
};
/** Product budgets have one local owner; parser/transport ceilings remain explicit validated safety bounds. */
function globalProvidersLimits(env = {}) {
    const names = {
            fileBytes: 'FILE_BYTES',
            providers: 'PROVIDERS',
            modelsPerProvider: 'MODELS',
            secretBytes: 'SECRET_BYTES',
            sessionMs: 'SESSION_MS',
            requestBytes: 'REQUEST_BYTES',
            publicBytes: 'PUBLIC_BYTES',
            httpRequestMs: 'HTTP_REQUEST_MS',
            httpHeadersMs: 'HTTP_HEADERS_MS',
            httpHeadersCount: 'HTTP_HEADERS_COUNT',
            sessions: 'SESSIONS',
        },
        result = {};
    for (const [key, suffix] of Object.entries(names)) {
        const raw = env['NEUROCENTER_GLOBAL_PROVIDER_' + suffix],
            value = raw === undefined ? DEFAULT_GLOBAL_PROVIDERS_LIMITS[key] : Number(raw);
        if (
            (raw !== undefined && !/^[1-9][0-9]*$/.test(raw)) ||
            !Number.isSafeInteger(value) ||
            value < (key === 'publicBytes' ? 1024 : 1) ||
            value > ceilings[key]
        )
            fail();
        result[key] = value;
    }
    return Object.freeze(result);
}
function normalizeGlobalProvidersInventory(value) {
    exact(value, ['providers', 'configurationFound', 'authenticationFound', 'overrideDetected', 'issues']);
    if (
        !Array.isArray(value.providers) ||
        value.providers.length > ceilings.providers ||
        !Array.isArray(value.issues) ||
        value.issues.length > issues.length ||
        new Set(value.issues).size !== value.issues.length ||
        value.issues.some((item) => !issues.includes(item)) ||
        ['configurationFound', 'authenticationFound', 'overrideDetected'].some((key) => typeof value[key] !== 'boolean')
    )
        fail();
    const ids = new Set();
    for (const row of value.providers) {
        exact(row, ['id', 'modelIds', 'hasConfiguration', 'hasAuthentication', 'authentication', 'enabled']);
        if (
            !providerId(row.id) ||
            ids.has(row.id) ||
            !Array.isArray(row.modelIds) ||
            row.modelIds.length > ceilings.modelsPerProvider ||
            row.modelIds.some((id) => !modelId(id)) ||
            new Set(row.modelIds).size !== row.modelIds.length ||
            ['hasConfiguration', 'hasAuthentication', 'enabled'].some((key) => typeof row[key] !== 'boolean') ||
            !['api', 'oauth', 'wellknown', 'reference', 'none', 'unknown'].includes(row.authentication)
        )
            fail();
        ids.add(row.id);
    }
    return structuredClone(value);
}
/** Stored account metadata deliberately makes no claim about effective models, endpoints or readiness. */
function normalizeOpenCodeAccountInventory(value) {
    exact(value, ['accounts', 'issues']);
    if (
        !Array.isArray(value.accounts) ||
        value.accounts.length > ceilings.providers ||
        !Array.isArray(value.issues) ||
        value.issues.length > issues.length ||
        new Set(value.issues).size !== value.issues.length ||
        value.issues.some((issue) => !issues.includes(issue))
    )
        fail();
    const ids = new Set();
    for (const row of value.accounts) {
        exact(row, ['integrationId', 'hasApiKey', 'hasOAuth', 'hasExternal']);
        if (
            !providerId(row.integrationId) ||
            ids.has(row.integrationId) ||
            ['hasApiKey', 'hasOAuth', 'hasExternal'].some((key) => typeof row[key] !== 'boolean')
        )
            fail();
        ids.add(row.integrationId);
    }
    return structuredClone(value);
}
function normalizeGlobalProvidersResult(value, expected) {
    exact(value, [
        'schemaVersion',
        'scope',
        'deviceId',
        'jobId',
        'kind',
        'checkedAt',
        'status',
        'inventory',
        'issue',
        'expiresAt',
        'adapter',
        'accountInventory',
    ]);
    normalizeGlobalProvidersPayload({
        schemaVersion: value.schemaVersion,
        scope: value.scope,
        deviceId: value.deviceId,
        ...(value.adapter !== undefined ? { adapter: value.adapter } : {}),
    });
    if (!uuid(value.jobId) || !kinds.includes(value.kind) || !timestamp(value.checkedAt)) fail();
    if (expected && ['deviceId', 'jobId', 'kind'].some((key) => value[key] !== expected[key])) fail();
    if (expected && value.adapter !== expected.adapter) fail();
    const v2 = value.adapter === OPENCODE_V2_ACCOUNTS_ADAPTER;
    if (v2 ? value.inventory !== undefined : value.accountInventory !== undefined) fail();
    if (value.status === 'failed') {
        if (!issues.includes(value.issue) || value.inventory !== undefined || value.accountInventory !== undefined)
            fail();
    } else if (value.kind === OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB) {
        if (
            value.status !== 'opened' ||
            value.inventory !== undefined ||
            value.accountInventory !== undefined ||
            value.issue !== undefined ||
            !timestamp(value.expiresAt) ||
            (expected?.expiresAt !== undefined && value.expiresAt !== expected.expiresAt)
        )
            fail();
    } else {
        if (!['checked', 'partial'].includes(value.status) || value.issue !== undefined) fail();
        const inventory = v2
            ? normalizeOpenCodeAccountInventory(value.accountInventory)
            : normalizeGlobalProvidersInventory(value.inventory);
        if (inventory.issues.length > 0 !== (value.status === 'partial')) fail();
    }
    if (value.status !== 'opened' && value.expiresAt !== undefined) fail();
    const raw = JSON.stringify(value);
    if (new TextEncoder().encode(raw).byteLength > ceilings.publicBytes) fail();
    return JSON.parse(raw);
}
const string = { type: 'string' },
    boolean = { type: 'boolean' },
    uuidSchema = { type: 'string', format: 'uuid', pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' },
    dateSchema = {
        type: 'string',
        format: 'date-time',
        pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$',
        description: 'Canonical UTC ISO timestamp with milliseconds; calendar date is validated at runtime.',
    };
const literal = (value) => ({ type: typeof value === 'number' ? 'integer' : typeof value, enum: [value] });
const schema = (properties, required = Object.keys(properties)) => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
});
const baseProperties = { schemaVersion: literal(1), scope: literal('global'), deviceId: uuidSchema };
const inventorySchema = schema({
    providers: {
        type: 'array',
        maxItems: ceilings.providers,
        items: schema({
            id: { ...string, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$' },
            modelIds: {
                type: 'array',
                uniqueItems: true,
                maxItems: ceilings.modelsPerProvider,
                items: { ...string, maxLength: 240, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$' },
            },
            hasConfiguration: boolean,
            hasAuthentication: boolean,
            authentication: { enum: ['api', 'oauth', 'wellknown', 'reference', 'none', 'unknown'] },
            enabled: boolean,
        }),
    },
    configurationFound: boolean,
    authenticationFound: boolean,
    overrideDetected: boolean,
    issues: { type: 'array', uniqueItems: true, maxItems: issues.length, items: { enum: issues } },
});
const identityProperties = { ...baseProperties, jobId: uuidSchema, kind: { enum: kinds }, checkedAt: dateSchema };
const adapterSchema = literal(OPENCODE_V2_ACCOUNTS_ADAPTER);
const accountInventorySchema = schema({
    accounts: {
        type: 'array',
        maxItems: ceilings.providers,
        items: schema({
            integrationId: { ...string, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$' },
            hasApiKey: boolean,
            hasOAuth: boolean,
            hasExternal: boolean,
        }),
    },
    issues: { type: 'array', uniqueItems: true, maxItems: issues.length, items: { enum: issues } },
});
const OPENCODE_GLOBAL_PROVIDERS_SCHEMAS = Object.freeze({
    request: schema(
        {
            deviceId: uuidSchema,
            kind: { type: 'string', enum: kinds },
            scope: literal('global'),
            requestKey: uuidSchema,
            adapter: adapterSchema,
        },
        ['deviceId', 'kind', 'scope', 'requestKey'],
    ),
    payloadRead: schema({ ...baseProperties, adapter: adapterSchema }, Object.keys(baseProperties)),
    payloadOpen: schema({ ...baseProperties, expiresAt: dateSchema, adapter: adapterSchema }, [
        ...Object.keys(baseProperties),
        'expiresAt',
    ]),
    inventory: inventorySchema,
    accountInventory: accountInventorySchema,
    results: {
        oneOf: [
            schema({
                ...identityProperties,
                kind: literal(OPENCODE_GLOBAL_PROVIDERS_READ_JOB),
                status: { type: 'string', enum: ['checked', 'partial'] },
                inventory: inventorySchema,
            }),
            schema({
                ...identityProperties,
                kind: literal(OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB),
                status: literal('opened'),
                expiresAt: dateSchema,
            }),
            schema({ ...identityProperties, status: literal('failed'), issue: { type: 'string', enum: issues } }),
            schema({
                ...identityProperties,
                adapter: adapterSchema,
                kind: literal(OPENCODE_GLOBAL_PROVIDERS_READ_JOB),
                status: { type: 'string', enum: ['checked', 'partial'] },
                accountInventory: accountInventorySchema,
            }),
            schema({
                ...identityProperties,
                adapter: adapterSchema,
                kind: literal(OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB),
                status: literal('opened'),
                expiresAt: dateSchema,
            }),
            schema({
                ...identityProperties,
                adapter: adapterSchema,
                status: literal('failed'),
                issue: { type: 'string', enum: issues },
            }),
        ],
    },
});
module.exports = {
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB,
    OPENCODE_GLOBAL_PROVIDERS_CAPABILITY,
    OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION,
    OPENCODE_V2_ACCOUNTS_ADAPTER,
    OPENCODE_V2_ACCOUNTS_CAPABILITY,
    OPENCODE_V2_ACCOUNTS_VERSION,
    DEFAULT_GLOBAL_PROVIDERS_LIMITS,
    OPENCODE_GLOBAL_PROVIDERS_SCHEMAS,
    globalProvidersLimits,
    normalizeGlobalProvidersRequest,
    normalizeGlobalProvidersPayload,
    normalizeGlobalProvidersInventory,
    normalizeOpenCodeAccountInventory,
    normalizeGlobalProvidersResult,
    globalProviderId: providerId,
    globalProviderModelId: modelId,
};
