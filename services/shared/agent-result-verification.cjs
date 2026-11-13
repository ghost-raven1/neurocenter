'use strict';
const { createHash } = require('node:crypto');
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, max) =>
    typeof value === 'string' && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
const exactKeys = (value, required, optional = []) =>
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const verificationFail = () => {
    throw new TypeError('Invalid agent result verification contract.');
};
const relativePath = (value) =>
    safeText(value, 256) &&
    !!value &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..');
const checkCommand = (value) => {
    if (
        !exactKeys(value, ['command', 'args']) ||
        !safeText(value.command, 128) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.command) ||
        !Array.isArray(value.args) ||
        value.args.length > 32 ||
        value.args.some((arg) => !safeText(arg, 2048))
    )
        verificationFail();
    return { command: value.command, args: [...value.args] };
};

/** Universal contract for an agent work result: machine-readable evidence, never model prose or captured stdout. */
const AGENT_RESULT_VERIFICATION_PROTOCOL = 'agent-result-verification-v1';
const VERIFICATION_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'unknown']);
const VERIFICATION_STAGES = Object.freeze(['prerequisites', 'execution', 'checks', 'completed']);
const VERIFICATION_CHECK_STATES = Object.freeze(['passed', 'failed', 'not_run']);
const VERIFICATION_FAILURE_CODES = Object.freeze([
    'CHECKS_REQUIRED',
    'EXECUTION_FAILED',
    'CHECK_FAILED',
    'AUTHORIZATION_LOST',
    'UNKNOWN_OUTCOME',
    'CANCELLED',
    'TIMEOUT',
    'OUTPUT_LIMIT',
    'OBSERVATION_LIMIT',
    'WORKSPACE_CHANGED',
    'PROVENANCE_MISMATCH',
]);
const VERIFICATION_FAILURE_ACTIONS = Object.freeze(['setup-checks', 'inspect-workspace', 'review-result', 'new-request']);
/** One observed check: real exit code/signal; not_run is distinct from failed and carries no exit. */
function normalizeVerificationChecks(rows) {
    if (!Array.isArray(rows) || rows.length > 8) verificationFail();
    return rows.map((row) => {
        if (
            !exactKeys(row, ['command', 'args', 'exitCode', 'signal', 'state']) ||
            !VERIFICATION_CHECK_STATES.includes(row.state) ||
            !(row.exitCode === null || Number.isSafeInteger(row.exitCode)) ||
            !(row.signal === null || safeText(row.signal, 32)) ||
            (row.state === 'passed' && (row.exitCode !== 0 || row.signal !== null)) ||
            (row.state === 'not_run' && (row.exitCode !== null || row.signal !== null))
        )
            verificationFail();
        const command = checkCommand({ command: row.command, args: row.args });
        return {
            command: command.command,
            args: command.args,
            exitCode: row.exitCode,
            signal: row.signal,
            state: row.state,
        };
    });
}
function normalizeVerificationChanges(rows) {
    if (!Array.isArray(rows) || rows.length > 64) verificationFail();
    for (const row of rows) {
        if (
            !exactKeys(row, ['path', 'beforeSha256', 'afterSha256']) ||
            !relativePath(row.path) ||
            !(row.beforeSha256 === null || sha256(row.beforeSha256)) ||
            !(row.afterSha256 === null || sha256(row.afterSha256)) ||
            row.beforeSha256 === row.afterSha256
        )
            verificationFail();
    }
    return rows.map((row) => ({ path: row.path, beforeSha256: row.beforeSha256, afterSha256: row.afterSha256 }));
}
function normalizeVerificationArtifacts(rows) {
    if (!Array.isArray(rows) || rows.length > 64) verificationFail();
    for (const row of rows) {
        if (!exactKeys(row, ['path', 'sha256']) || !relativePath(row.path) || !sha256(row.sha256)) verificationFail();
    }
    return rows.map((row) => ({ path: row.path, sha256: row.sha256 }));
}
/**
 * Outcome invariants shared by every verification contract (device method workflow and generic agent work):
 * `succeeded` only after the selected checks all passed and the run completed; every other state names a failure.
 */
function assertVerificationOutcome(state, stage, checks, failure, codes, actions) {
    if (
        failure !== undefined &&
        (!exactKeys(failure, ['code', 'action']) || !codes.includes(failure.code) || !actions.includes(failure.action))
    )
        verificationFail();
    if (
        state === 'succeeded' &&
        (stage !== 'completed' || failure || !checks.length || checks.some((row) => row.state !== 'passed'))
    )
        verificationFail();
    if (state !== 'succeeded' && !failure) verificationFail();
}
/** Declared verification of a task: the exact checks whose outcomes must be reported (provenance, NFR-4). */
function normalizeVerificationIntent(declared) {
    if (
        !exactKeys(declared, ['protocol', 'checks']) ||
        declared.protocol !== AGENT_RESULT_VERIFICATION_PROTOCOL ||
        !Array.isArray(declared.checks) ||
        declared.checks.length < 1 ||
        declared.checks.length > 8
    )
        verificationFail();
    return { protocol: AGENT_RESULT_VERIFICATION_PROTOCOL, checks: declared.checks.map(checkCommand) };
}
function verificationIntentDigest(intent) {
    return createHash('sha256').update(JSON.stringify(normalizeVerificationIntent(intent))).digest('hex');
}
/**
 * A generic verified agent result: state, stage and the real check outcomes (plus observed change/artifact hashes).
 * With `intent`, the result must describe exactly the declared selected checks; raw stdout, instructions and
 * secrets never cross the wire. `succeeded` without a passing check is not a result.
 */
function normalizeVerificationResult(value, intent) {
    if (
        !exactKeys(value, ['protocol', 'state', 'stage', 'checks'], ['changes', 'artifacts', 'failure']) ||
        value.protocol !== AGENT_RESULT_VERIFICATION_PROTOCOL ||
        !VERIFICATION_STATES.includes(value.state) ||
        !VERIFICATION_STAGES.includes(value.stage)
    )
        verificationFail();
    const checks = normalizeVerificationChecks(value.checks);
    const changes = Object.hasOwn(value, 'changes') ? normalizeVerificationChanges(value.changes) : undefined;
    const artifacts = Object.hasOwn(value, 'artifacts') ? normalizeVerificationArtifacts(value.artifacts) : undefined;
    assertVerificationOutcome(
        value.state,
        value.stage,
        checks,
        value.failure,
        VERIFICATION_FAILURE_CODES,
        VERIFICATION_FAILURE_ACTIONS,
    );
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) verificationFail();
    if (intent !== undefined) {
        const declared = normalizeVerificationIntent(intent);
        if (
            JSON.stringify(checks.map(({ command, args }) => ({ command, args }))) !==
            JSON.stringify(declared.checks)
        )
            verificationFail();
    }
    return JSON.parse(
        JSON.stringify({
            protocol: value.protocol,
            state: value.state,
            stage: value.stage,
            checks,
            ...(changes !== undefined ? { changes } : {}),
            ...(artifacts !== undefined ? { artifacts } : {}),
            ...(value.failure ? { failure: { code: value.failure.code, action: value.failure.action } } : {}),
        }),
    );
}
/**
 * Fail-closed acceptance gate: «done» without verification is not accepted. A succeeded acknowledgement
 * requires a succeeded result (completed, selected checks passed); a failed acknowledgement requires an
 * explicit non-succeeded result (not_run/failed/unknown/cancelled with a named failure).
 */
function assertAgentResultAccepted(value, failed, intent) {
    const checked = normalizeVerificationResult(value, intent);
    if ((checked.state === 'succeeded') === failed)
        throw new TypeError('Agent result verification mismatch: the outcome does not match the acknowledged state.');
    return checked;
}
module.exports = {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    VERIFICATION_STATES,
    VERIFICATION_STAGES,
    VERIFICATION_CHECK_STATES,
    VERIFICATION_FAILURE_CODES,
    VERIFICATION_FAILURE_ACTIONS,
    verificationUuid: uuid,
    verificationSha256: sha256,
    verificationObject: object,
    verificationSafeText: safeText,
    verificationExact: exactKeys,
    verificationRelativePath: relativePath,
    verificationCheckCommand: checkCommand,
    normalizeVerificationChecks,
    normalizeVerificationChanges,
    normalizeVerificationArtifacts,
    assertVerificationOutcome,
    normalizeVerificationIntent,
    verificationIntentDigest,
    normalizeVerificationResult,
    assertAgentResultAccepted,
};
