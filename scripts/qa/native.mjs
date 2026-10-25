#!/usr/bin/env node
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runBuildProcess} from '../workspace/isolated-build-process.mjs';
import {readNativeCandidate, nativeHarnessHashes} from './native-candidate.mjs';
import {admitManagedPostgres} from './postgres-admission.mjs';
import {postgresPaths, isRunId, assertPostgresFlag, privateQaDirectory, saveQaJson, readQaFile, sha256, QaPostgresError} from './postgres-contract.mjs';

const workspace = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const scenario = 'publication-rollback';
export const nativeHelp = `Opt-in native QA on a managed PostgreSQL fixture and an isolated Catalog candidate.
  node scripts/qa/native.mjs plan|run --run <uuid> --candidate <absolute-receipt> --scenario publication-rollback
The fixed scenario executes two PluginRepository transaction rollback cases. Other harness cases are excluded.
plan reads candidate/harness evidence only. run creates a private attempt and never closes or purges the cluster.
Requires Node24; NEUROCENTER_QA_POSTGRES=0 disables new runs but preserves planning/history.`;

/** No arbitrary commands, patterns, URLs or output directories are accepted. */
export function parseNativeArguments(args, environment = process.env) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
    const [action, ...flags] = args, options = {action};
    if (!['plan', 'run'].includes(action)) throw new QaPostgresError('QA_INVALID_ARGUMENT');
    for (let index = 0; index < flags.length; index += 2) {
        const key = {'--run': 'runId', '--candidate': 'candidate', '--scenario': 'scenario'}[flags[index]], value = flags[index + 1];
        if (!key || Object.hasOwn(options, key) || typeof value !== 'string' || !value || value.startsWith('--')) throw new QaPostgresError('QA_INVALID_ARGUMENT');
        options[key] = value;
    }
    if (!isRunId(options.runId) || options.scenario !== scenario || !path.isAbsolute(options.candidate ?? '')
        || path.resolve(options.candidate) !== options.candidate) throw new QaPostgresError('QA_INVALID_ARGUMENT');
    assertPostgresFlag(environment, action);
    return options;
}

export async function planNativeQa(root, options) {
    const candidate = await readNativeCandidate(root, options.candidate), harnessHashes = await nativeHarnessHashes(root);
    return {action: 'plan', scenario, runId: options.runId, candidate: candidate.receipt, candidateFingerprint: candidate.fingerprint,
        harnessHashes, selectedCases: 2, casePattern: '^PluginRepository own transaction:',
        scope: 'Two real SQL transaction rollback cases; Skills/native publication and all other harness cases are excluded.', limits: candidate.limits};
}

function validNativeReceipt(value, {ownerNonce, candidate, sourceReceipt, sourceReceiptSha256, processWindow}) {
    const cases = value?.cases;
    const started = Date.parse(value?.startedAt), finished = Date.parse(value?.finishedAt);
    const required = ['primary error identity retained', 'observer sees no failed publication before unrelated COMMIT',
        'observer sees no failed publication after unrelated COMMIT', 'normal rollback reuses PID; unknown rollback discards it',
        'release destroys unknown rollback session'];
    return value?.schemaVersion === 1 && value.status === 'GREEN'
        && value.ownerNonce === ownerNonce && value.candidate === candidate.repository
        && value.sourceReceiptFile === sourceReceipt && value.sourceReceiptSha256 === sourceReceiptSha256
        && isDeepStrictEqual(value.sourceHashes, candidate.sourceReceipt.hashes)
        && isDeepStrictEqual(value.liveSourceHashes, candidate.sourceReceipt.hashes)
        && Array.isArray(value.liveSourceDrift) && value.liveSourceDrift.length === 0
        && isDeepStrictEqual(value.compiledHashes, candidate.compiledHashes)
        && Number.isFinite(started) && Number.isFinite(finished) && started <= finished
        && started >= Date.parse(processWindow.startedAt) && finished <= Date.parse(processWindow.finishedAt)
        && value.ownDatabaseDropped === true && value.originalDatabasesPreserved === true
        && Array.isArray(value.cleanupErrors) && value.cleanupErrors.length === 0
        && Array.isArray(value.harnessFailures) && value.harnessFailures.length === 0
        && Array.isArray(value.causalFailures) && value.causalFailures.length === 0
        && Array.isArray(cases) && cases.length === 2 && new Set(cases.map(item => item.rollback)).size === 2
        && cases.every(item => item.owner === 'PluginRepository' && ['normal', 'not-dispatched'].includes(item.rollback)
            && Array.isArray(item.invariants) && required.every(name => item.invariants.some(invariant => invariant.name === name && invariant.passed === true))
            && item.invariants.every(invariant => invariant.passed === true));
}

/** Execute one fixed existing harness and retain outcome, ownership, source and cleanup separately. */
export async function runNativeQa(root, options, {environment = process.env, signal, execute = runBuildProcess,
    admit = admitManagedPostgres, timeoutMs = 180000} = {}) {
    assertPostgresFlag(environment, 'run');
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new QaPostgresError('QA_NODE_REQUIRED');
    const plan = await planNativeQa(root, options), candidate = await readNativeCandidate(root, options.candidate);
    const paths = postgresPaths(root, options.runId);
    if (signal?.aborted) throw new QaPostgresError('QA_CANCELLED');
    const admission = await admit(paths.connection, {root, environment});
    const admittedOwner = {ownerNonce: admission.owner.nonce, runDirectory: admission.owner.runDirectory};
    if (typeof admittedOwner.ownerNonce !== 'string' || !admittedOwner.ownerNonce || admittedOwner.runDirectory !== paths.directory)
        throw new QaPostgresError('QA_METADATA_INVALID');
    const attemptId = randomUUID(), attempts = path.join(paths.directory, 'scenarios'), directory = path.join(attempts, attemptId);
    try { await privateQaDirectory(attempts, {create: true}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await privateQaDirectory(attempts); }
    await privateQaDirectory(directory, {create: true});
    const filename = path.join(directory, 'receipt.json'), sourceReceipt = path.join(directory, 'source-receipt.json');
    const nativeReceiptName = 'publication-rollback-' + attemptId + '.json', nativeReceipt = path.join(paths.directory, nativeReceiptName);
    const receipt = {schemaVersion: 1, kind: 'neurocenter-qa-native', attemptId, runId: options.runId, scenario,
        startedAt: new Date().toISOString(), status: 'preparing', complete: false, selectedCases: 2,
        candidate: candidate.receipt, candidateFingerprint: candidate.fingerprint, harnessHashes: plan.harnessHashes,
        admittedOwner, sourceReceipt, sourceReceiptSha256: null, sourceReceiptUnchanged: null, processWindow: null,
        process: null, nativeReceipt, nativeResultValid: false, candidateUnchanged: null, harnessUnchanged: null,
        fixtureReadyAfter: null, failure: null, finalizationErrors: [], limits: [plan.scope, ...candidate.limits]};
    const save = () => saveQaJson(filename, receipt), fail = code => { receipt.failure ??= {code}; };
    try {
        await save(); await saveQaJson(sourceReceipt, candidate.sourceReceipt);
        receipt.sourceReceiptSha256 = sha256(await readQaFile(sourceReceipt, {privateMode: true, maximumBytes: 8 * 1024 ** 2}));
        const current = await readNativeCandidate(root, options.candidate);
        if (current.fingerprint !== candidate.fingerprint || !isDeepStrictEqual(await nativeHarnessHashes(root), plan.harnessHashes))
            throw new QaPostgresError('QA_SOURCE_CHANGED');
        receipt.status = 'running'; receipt.processWindow = {startedAt: new Date().toISOString(), finishedAt: null}; await save();
        const result = await execute({node: process.execPath, args: ['--test', '--test-concurrency=1', '--test-name-pattern',
            '^PluginRepository own transaction:', 'scripts/test/native/package-publication-rollback.test.mjs'], cwd: root,
            env: {PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin', NODE_BIN: process.execPath,
                NEUROCENTER_QA_POSTGRES: '1', PACKAGE_PUBLICATION_ROLLBACK_CONNECTION_FILE: paths.connection,
                PACKAGE_PUBLICATION_ROLLBACK_CANDIDATE: candidate.repository,
                PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT: sourceReceipt, PACKAGE_PUBLICATION_ROLLBACK_RECEIPT_NAME: nativeReceiptName},
            logFile: path.join(directory, 'native.log'), signal, timeoutMs});
        receipt.processWindow.finishedAt = new Date().toISOString();
        receipt.process = {ok: result.ok, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs,
            leaderReaped: result.leaderReaped, cleanup: {noLiveDescendants: result.cleanup?.noLiveDescendants === true},
            ...(result.failure ? {failure: {code: result.failure.code}} : {})};
        if (result.ok !== true || result.exitCode !== 0 || result.signal !== null || result.leaderReaped !== true || result.cleanup?.noLiveDescendants !== true)
            fail(signal?.aborted ? 'QA_CANCELLED' : 'QA_NATIVE_PROCESS_FAILED');
        try { receipt.nativeResultValid = sha256(await readQaFile(sourceReceipt, {privateMode: true, maximumBytes: 8 * 1024 ** 2})) === receipt.sourceReceiptSha256
            && validNativeReceipt(JSON.parse((await readQaFile(nativeReceipt, {privateMode: true, maximumBytes: 8 * 1024 ** 2})).toString('utf8')),
                {ownerNonce: admittedOwner.ownerNonce, candidate, sourceReceipt, sourceReceiptSha256: receipt.sourceReceiptSha256, processWindow: receipt.processWindow}); }
        catch { receipt.nativeResultValid = false; }
        if (!receipt.nativeResultValid) fail('QA_NATIVE_RESULT_INCOMPLETE');
    } catch (error) { fail(error instanceof QaPostgresError ? error.code : 'QA_NATIVE_FAILED'); }
    finally {
        try { receipt.sourceReceiptUnchanged = sha256(await readQaFile(sourceReceipt, {privateMode: true, maximumBytes: 8 * 1024 ** 2})) === receipt.sourceReceiptSha256;
            if (!receipt.sourceReceiptUnchanged) fail('QA_SOURCE_CHANGED'); }
        catch { receipt.sourceReceiptUnchanged = false; fail('QA_SOURCE_CHANGED'); }
        try { receipt.candidateUnchanged = (await readNativeCandidate(root, options.candidate)).fingerprint === candidate.fingerprint;
            receipt.harnessUnchanged = isDeepStrictEqual(await nativeHarnessHashes(root), plan.harnessHashes);
            if (!receipt.candidateUnchanged || !receipt.harnessUnchanged) fail('QA_SOURCE_CHANGED'); }
        catch { receipt.candidateUnchanged = false; fail('QA_SOURCE_CHANGED'); }
        try { const after = await admit(paths.connection, {root, environment});
            receipt.fixtureReadyAfter = after.owner.nonce === admittedOwner.ownerNonce && after.owner.runDirectory === admittedOwner.runDirectory;
            if (!receipt.fixtureReadyAfter) fail('QA_FIXTURE_NOT_READY'); }
        catch { receipt.fixtureReadyAfter = false; fail('QA_FIXTURE_NOT_READY'); }
        if (signal?.aborted) fail('QA_CANCELLED');
        receipt.complete = !receipt.failure && receipt.nativeResultValid && receipt.sourceReceiptUnchanged && receipt.candidateUnchanged && receipt.harnessUnchanged && receipt.fixtureReadyAfter;
        receipt.status = signal?.aborted ? 'cancelled' : receipt.complete ? 'passed' : 'failed';
        receipt.finishedAt = new Date().toISOString();
        try {
            await save();
            if (signal?.aborted && receipt.status !== 'cancelled') {
                receipt.complete = false; receipt.status = 'cancelled'; fail('QA_CANCELLED');
                receipt.finishedAt = new Date().toISOString(); await save();
            }
        }
        catch { receipt.complete = false; receipt.status = 'failed'; fail('QA_RECEIPT_FAILED'); throw new QaPostgresError('QA_RECEIPT_FAILED'); }
    }
    return {runId: options.runId, attemptId, scenario, status: receipt.status, complete: receipt.complete,
        selectedCases: 2, receipt: filename, clusterRetained: true, failure: receipt.failure};
}

export async function main(args, {root = workspace, environment = process.env, output = process.stdout, errorOutput = process.stderr} = {}) {
    const options = parseNativeArguments(args, environment);
    if (options.help) { output.write(nativeHelp + '\n'); return 0; }
    const controller = new AbortController(), interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    try {
        const value = options.action === 'plan' ? await planNativeQa(root, options) : await runNativeQa(root, options, {environment, signal: controller.signal});
        output.write(JSON.stringify(value, null, 2) + '\n');
        return controller.signal.aborted ? controller.signal.reason === 'SIGTERM' ? 143 : 130 : options.action === 'plan' || value.complete ? 0 : 1;
    } catch (error) { errorOutput.write((error instanceof QaPostgresError ? error.code : 'QA_NATIVE_FAILED') + '\n');
        return controller.signal.aborted ? controller.signal.reason === 'SIGTERM' ? 143 : 130 : 1; }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try { process.exitCode = await main(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof QaPostgresError ? error.code : 'QA_NATIVE_FAILED'); process.exitCode = 1; }
}
