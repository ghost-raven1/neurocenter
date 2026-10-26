import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {runBuildProcess} from './isolated-build-process.mjs';

export const coverageLifecycleFailureCodes = Object.freeze([
    'CANCELLED', 'COVERAGE_TIMEOUT', 'COVERAGE_FAILED', 'COVERAGE_LOG_LIMIT',
    'SPAWN_FAILED', 'PROCESS_CLEANUP_FAILED', 'PROCESS_INSPECTION_FAILED', 'SURVIVING_DESCENDANTS',
    'TEST_REPORT_FAILED', 'COVERAGE_EXECUTION_FAILED', 'SOURCE_CHANGED', 'COVERAGE_FINALIZATION_FAILED',
]);
const failureCodes = new Set(coverageLifecycleFailureCodes);
const renamed = {BUILD_TIMEOUT: 'COVERAGE_TIMEOUT', BUILD_FAILED: 'COVERAGE_FAILED', BUILD_LOG_LIMIT: 'COVERAGE_LOG_LIMIT'};

/** Keep the requested order and incomplete state before any owned subprocess starts. */
export function createRunLifecycle(plannedSteps) {
    if (!Array.isArray(plannedSteps) || !plannedSteps.length || plannedSteps.some(id => typeof id !== 'string' || !id)
        || new Set(plannedSteps).size !== plannedSteps.length) throw Error('A lifecycle requires unique ordered step IDs.');
    return {schemaVersion: 1, state: 'preparing', plannedSteps: [...plannedSteps], steps: [],
        failure: null, cancellation: null, finalizationErrors: []};
}

/** Preserve the first failure; unrelated exception text never enters public lifecycle metadata. */
export function failRunLifecycle(lifecycle, code, {finalization = false} = {}) {
    const failure = {code: failureCodes.has(code) ? code : 'COVERAGE_EXECUTION_FAILED'};
    lifecycle.failure ??= failure;
    if (finalization) lifecycle.finalizationErrors.push(failure);
}

/** Replace one receipt atomically; failure leaves the previous incomplete receipt authoritative. */
export async function saveRunManifest(filename, manifest) {
    const temporary = path.join(path.dirname(filename), '.' + path.basename(filename) + '.' + randomUUID() + '.tmp');
    try {
        await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, filename);
    } finally {
        await fs.rm(temporary, {force: true}).catch(() => {});
    }
}

/** Reuse the existing POSIX supervisor; retain a running prefix and a bounded public process result. */
export async function runLifecycleStep(lifecycle, id, options, {save = async () => {}, execute = runBuildProcess} = {}) {
    if (lifecycle.failure || id !== lifecycle.plannedSteps[lifecycle.steps.length]) throw Error('Lifecycle step is outside the admitted prefix.');
    lifecycle.state = 'running';
    const step = {id, startedAt: new Date().toISOString(), finishedAt: null, result: null};
    lifecycle.steps.push(step);
    let result;
    try {
        await save();
        result = await execute(options);
        step.result = {ok: result.ok === true, exitCode: result.exitCode ?? null, signal: result.signal ?? null,
            durationMs: result.durationMs, leaderReaped: result.leaderReaped === true,
            cleanup: {noLiveDescendants: result.cleanup?.noLiveDescendants === true,
                zombiePids: result.cleanup?.zombiePids ?? [], signals: result.cleanup?.signals ?? []},
            ...(result.failure ? {failure: {code: renamed[result.failure.code]
                || (failureCodes.has(result.failure.code) ? result.failure.code : 'COVERAGE_EXECUTION_FAILED')}} : {})};
    } catch {
        step.result = {ok: false, exitCode: null, signal: null, durationMs: Math.max(0, Date.now() - Date.parse(step.startedAt)),
            leaderReaped: false, cleanup: {noLiveDescendants: false, zombiePids: [], signals: []},
            failure: {code: 'COVERAGE_EXECUTION_FAILED'}};
    }
    step.finishedAt = new Date().toISOString();
    if (!step.result.ok) failRunLifecycle(lifecycle, step.result.failure?.code || 'COVERAGE_FAILED');
    await save();
    return step.result;
}

/** Process completion is separate from test omissions and the measured coverage denominator. */
export function runLifecycleSucceeded(lifecycle) {
    return !!lifecycle && lifecycle.schemaVersion === 1 && lifecycle.state === 'passed'
        && lifecycle.failure === null && lifecycle.cancellation === null
        && Array.isArray(lifecycle.finalizationErrors) && lifecycle.finalizationErrors.length === 0
        && Array.isArray(lifecycle.plannedSteps) && lifecycle.plannedSteps.length > 0
        && lifecycle.plannedSteps.every(id => typeof id === 'string' && id.length > 0)
        && new Set(lifecycle.plannedSteps).size === lifecycle.plannedSteps.length
        && Array.isArray(lifecycle.steps) && lifecycle.steps.length === lifecycle.plannedSteps.length
        && lifecycle.steps.every((step, index) => step?.id === lifecycle.plannedSteps[index]
            && typeof step.startedAt === 'string' && Number.isFinite(Date.parse(step.startedAt))
            && typeof step.finishedAt === 'string' && Number.isFinite(Date.parse(step.finishedAt))
            && Date.parse(step.startedAt) <= Date.parse(step.finishedAt)
            && (!index || Date.parse(step.startedAt) >= Date.parse(lifecycle.steps[index - 1].finishedAt))
            && step.result?.ok === true && step.result.exitCode === 0
            && step.result.signal === null && step.result.leaderReaped === true
            && Number.isSafeInteger(step.result.durationMs) && step.result.durationMs >= 0
            && step.result.cleanup?.noLiveDescendants === true
            && Array.isArray(step.result.cleanup.zombiePids) && step.result.cleanup.zombiePids.every(pid => Number.isSafeInteger(pid) && pid > 0)
            && Array.isArray(step.result.cleanup.signals) && step.result.cleanup.signals.every(value => ['SIGTERM', 'SIGKILL'].includes(value))
            && !step.result.failure);
}
