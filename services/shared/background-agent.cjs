'use strict';
const { createHash } = require('node:crypto');
const { AGENT_METHOD_VERSIONS } = require('./agent-method-workflow.cjs');
const {
    verificationUuid: uuid,
    verificationObject: object,
    verificationSafeText: text,
    verificationExact: exact,
    verificationCheckCommand: checkCommand,
} = require('./agent-result-verification.cjs');

const BACKGROUND_AGENT_PROTOCOL = 'background-agent-v1';
const BACKGROUND_AGENT_JOB = 'run-background-agent';
const BACKGROUND_AGENT_RUNTIME = 'opencode';
/** Configurable context sources (FR-305). Adding a source = extend this list + a provider (context seam). */
const BACKGROUND_AGENT_CONTEXT_SOURCES = Object.freeze(['project', 'computer', 'web']);
const BACKGROUND_AGENT_PAYLOAD_FIELDS = [
    'protocol',
    'workflowId',
    'requestId',
    'projectId',
    'method',
    'methodVersion',
    'instruction',
    'checks',
    'deadlineAt',
    'runtime',
];
const fail = () => {
    throw new TypeError('Invalid background agent contract.');
};
const isoDate = (value) => {
    if (!text(value, 40)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && value === new Date(parsed).toISOString();
};
/**
 * Context is a bounded descriptor per source; the provider (server worker) resolves it into session
 * context. The contract fixes the source set and size only — internals are the provider's extension seam.
 */
function normalizeBackgroundAgentContext(value) {
    if (value === undefined) return undefined;
    if (!object(value)) fail();
    const out = {};
    for (const [source, section] of Object.entries(value)) {
        if (!BACKGROUND_AGENT_CONTEXT_SOURCES.includes(source) || !object(section)) fail();
        if (Buffer.byteLength(JSON.stringify(section)) > 4096) fail();
        out[source] = JSON.parse(JSON.stringify(section));
    }
    return Object.keys(out).length ? out : undefined;
}
/**
 * Immutable background-agent task. The method version and deadline are fixed by the server (never runtime
 * instructions). `checks` is the declared verification intent (FR-304): the result must describe exactly
 * these checks. `context` selects configurable project/computer/web sources (FR-305).
 */
function normalizeBackgroundAgentPayload(value) {
    if (
        !exact(value, BACKGROUND_AGENT_PAYLOAD_FIELDS, ['context']) ||
        value.protocol !== BACKGROUND_AGENT_PROTOCOL ||
        !uuid(value.workflowId) ||
        !uuid(value.requestId) ||
        !text(value.projectId, 200) ||
        !value.projectId ||
        !Object.hasOwn(AGENT_METHOD_VERSIONS, value.method) ||
        value.methodVersion !== AGENT_METHOD_VERSIONS[value.method] ||
        !text(value.instruction, 32 * 1024) ||
        !value.instruction ||
        !Array.isArray(value.checks) ||
        value.checks.length < 1 ||
        value.checks.length > 8 ||
        !isoDate(value.deadlineAt) ||
        value.runtime !== BACKGROUND_AGENT_RUNTIME
    )
        fail();
    const normalized = {
        protocol: value.protocol,
        workflowId: value.workflowId,
        requestId: value.requestId,
        projectId: value.projectId,
        method: value.method,
        methodVersion: value.methodVersion,
        instruction: value.instruction,
        checks: value.checks.map(checkCommand),
        deadlineAt: value.deadlineAt,
        runtime: value.runtime,
    };
    const context = normalizeBackgroundAgentContext(value.context);
    if (context) normalized.context = context;
    return JSON.parse(JSON.stringify(normalized));
}
/** Receipt idempotency: a stable digest over the normalized immutable payload. */
function backgroundAgentDigest(payload) {
    return createHash('sha256').update(JSON.stringify(normalizeBackgroundAgentPayload(payload))).digest('hex');
}
module.exports = {
    BACKGROUND_AGENT_PROTOCOL,
    BACKGROUND_AGENT_JOB,
    BACKGROUND_AGENT_RUNTIME,
    BACKGROUND_AGENT_CONTEXT_SOURCES,
    normalizeBackgroundAgentPayload,
    normalizeBackgroundAgentContext,
    backgroundAgentDigest,
};
