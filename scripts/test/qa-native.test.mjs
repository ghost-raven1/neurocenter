import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readNativeCandidate, nativeHarnessFiles, nativeHarnessHashes} from '../qa/native-candidate.mjs';
import {parseNativeArguments, planNativeQa, runNativeQa, main} from '../qa/native.mjs';
import {saveQaJson} from '../qa/postgres-contract.mjs';
import {ownedConnection, root as sourceRoot} from './package-publication-rollback.fixture.mjs';
import {nativeCandidateFixture, successfulNativeReceipt, completedProcess} from './qa-native.fixture.mjs';

test('native arguments select only the fixed scenario and disabled runs fail before candidate access', async () => {
    const id = '11111111-1111-4111-8111-111111111111', base = ['run', '--run', id, '--candidate', '/missing/receipt.json', '--scenario', 'publication-rollback'];
    assert.equal(parseNativeArguments(base).scenario, 'publication-rollback');
    assert.throws(() => parseNativeArguments(base, {NEUROCENTER_QA_POSTGRES: '0'}), error => error.code === 'QA_DISABLED');
    assert.equal(parseNativeArguments(['plan', ...base.slice(1)], {NEUROCENTER_QA_POSTGRES: '0'}).action, 'plan');
    for (const args of [[...base, '--shell', 'anything'], base.map(value => value === 'publication-rollback' ? 'arbitrary' : value),
        base.map(value => value === '/missing/receipt.json' ? '../receipt.json' : value), [...base, '--run', id]])
        assert.throws(() => parseNativeArguments(args), error => error.code === 'QA_INVALID_ARGUMENT');
});

test('a selected isolated candidate verifies current source and exact compiled bytes without PG', async t => {
    const f = await nativeCandidateFixture(t), candidate = await readNativeCandidate(f.root, f.receipt);
    assert.equal(candidate.repository, f.repository); assert.equal(candidate.sourceReceipt.sourceFiles.length, Object.keys(f.sources).length);
    const plan = await planNativeQa(f.root, f.options); assert.equal(plan.selectedCases, 2); assert.equal(plan.casePattern, '^PluginRepository own transaction:');
    assert.deepEqual(await fs.readdir(f.cluster), [], 'Planning must not create run artifacts.');
});

test('the bounded harness inventory includes the shared source-validation implementation', async t => {
    const f = await nativeCandidateFixture(t), name = 'scripts/workspace/isolated-build-source.mjs';
    assert.ok(nativeHarnessFiles.includes(name));
    assert.equal(typeof (await nativeHarnessHashes(f.root))[name], 'string');
    await f.put(f.root, name, Buffer.alloc(1024 ** 2 + 1));
    await assert.rejects(nativeHarnessHashes(f.root), error => error.code === 'INPUT_LIMIT');
});

for (const kind of ['source-edit', 'source-addition', 'artifact-edit', 'receipt-failure', 'symlink-receipt']) test('candidate rejects ' + kind + ' before execution', async t => {
    const f = await nativeCandidateFixture(t);
    if (kind === 'source-edit') await f.put(f.root, 'services/shared/runtime.cjs', 'changed');
    if (kind === 'source-addition') await f.put(f.root, 'services/catalog-service/src/new.ts', 'export const added = true;');
    if (kind === 'artifact-edit') await f.put(f.repository, 'services/catalog-service/dist/main.js', 'changed');
    if (kind === 'receipt-failure') { f.value.ok = false; await f.save(); }
    if (kind === 'symlink-receipt') { await fs.rename(f.receipt, f.receipt + '.old'); await fs.symlink(f.receipt + '.old', f.receipt); }
    await assert.rejects(readNativeCandidate(f.root, f.receipt));
});

/** The supervisor and SQL ledger are controlled; real PG acceptance belongs to the opt-in parent run. */
async function runFixture(t, change = () => {}, {signal} = {}) {
    const f = await nativeCandidateFixture(t); let admissions = 0, seenEnvironment;
    const result = await runNativeQa(f.root, f.options, {signal, environment: {PGHOST: 'foreign.invalid', NODE_OPTIONS: '--bad-preload', TOKEN: 'caller-secret'},
        admit: async () => { admissions++; return {owner: f.owner}; }, execute: async options => {
            seenEnvironment = options.env;
            const initial = JSON.parse(await fs.readFile(path.join(path.dirname(options.logFile), 'receipt.json'), 'utf8'));
            assert.equal(initial.complete, false); assert.equal(initial.status, 'running');
            const native = await successfulNativeReceipt({env: options.env, owner: f.owner}), process = completedProcess(); await change({f, native, process, options});
            await saveQaJson(path.join(f.cluster, options.env.PACKAGE_PUBLICATION_ROLLBACK_RECEIPT_NAME), native);
            return process;
        }});
    return {f, result, admissions, seenEnvironment};
}

test('native run publishes a bounded selected-case result only after source, process and cleanup gates', async t => {
    const {result, admissions, seenEnvironment} = await runFixture(t);
    assert.equal(result.complete, true); assert.equal(result.selectedCases, 2); assert.equal(result.status, 'passed'); assert.equal(admissions, 2);
    assert.equal(seenEnvironment.PGHOST, undefined); assert.equal(seenEnvironment.NODE_OPTIONS, undefined); assert.equal(seenEnvironment.TOKEN, undefined);
    assert.ok(!JSON.stringify(result).includes('caller-secret')); assert.equal(result.clusterRetained, true);
});

test('SIGTERM during the terminal rename republishes cancellation before returning', async t => {
    const controller = new AbortController(), rename = fs.rename; let interrupted = false;
    fs.rename = async (source, target) => {
        await rename(source, target);
        if (target.includes(path.sep + 'scenarios' + path.sep) && path.basename(target) === 'receipt.json') {
            const saved = JSON.parse(await fs.readFile(target, 'utf8'));
            if (saved.status === 'passed') { interrupted = true; controller.abort('SIGTERM'); }
        }
    };
    try {
        const {result} = await runFixture(t, undefined, {signal: controller.signal});
        assert.equal(interrupted, true); assert.equal(result.complete, false); assert.equal(result.status, 'cancelled');
        assert.equal(result.failure.code, 'QA_CANCELLED');
        const saved = JSON.parse(await fs.readFile(result.receipt, 'utf8'));
        assert.equal(saved.complete, false); assert.equal(saved.status, 'cancelled'); assert.equal(saved.failure.code, 'QA_CANCELLED');
    } finally { fs.rename = rename; }
});

test('CLI cancellation dominates an otherwise successful plan result', async t => {
    const f = await nativeCandidateFixture(t);
    const exit = await main(['plan', '--run', f.options.runId, '--candidate', f.receipt, '--scenario', 'publication-rollback'],
        {root: f.root, output: {write: () => process.emit('SIGTERM')}});
    assert.equal(exit, 143);
});

for (const kind of ['cleanup', 'missing-case', 'invariant', 'unreaped', 'source-drift', 'source-validator-drift']) test('native result cannot hide ' + kind, async t => {
    const {result} = await runFixture(t, async ({f, native, process}) => {
        if (kind === 'cleanup') native.cleanupErrors.push({message: 'owned cleanup failed'});
        if (kind === 'missing-case') native.cases.pop();
        if (kind === 'invariant') native.cases[0].invariants[0].passed = false;
        if (kind === 'unreaped') { process.leaderReaped = false; process.cleanup.noLiveDescendants = false; }
        if (kind === 'source-drift') await f.put(f.root, 'services/shared/runtime.cjs', 'changed during run');
        if (kind === 'source-validator-drift') await f.put(f.root, 'scripts/workspace/isolated-build-source.mjs', '// changed validator during run');
    });
    assert.equal(result.complete, false); assert.equal(result.status, 'failed'); assert.ok(result.failure.code);
});

for (const kind of ['owner-nonce', 'candidate', 'source-path', 'source-sha', 'source-hashes', 'compiled-hashes', 'stale-time', 'future-time', 'source-receipt-drift'])
    test('an otherwise GREEN receipt cannot substitute ' + kind, async t => {
        const {result} = await runFixture(t, async ({f, native, options}) => {
            if (kind === 'owner-nonce') native.ownerNonce = 'stale-owner';
            if (kind === 'candidate') native.candidate = path.join(f.root, 'substituted-repository');
            if (kind === 'source-path') native.sourceReceiptFile = path.join(f.root, 'substituted-source.json');
            if (kind === 'source-sha') native.sourceReceiptSha256 = '0'.repeat(64);
            if (kind === 'source-hashes') native.sourceHashes[Object.keys(native.sourceHashes)[0]] = '0'.repeat(64);
            if (kind === 'compiled-hashes') native.compiledHashes[Object.keys(native.compiledHashes)[0]] = '0'.repeat(64);
            if (kind === 'stale-time') native.startedAt = native.finishedAt = '2020-01-01T00:00:00.000Z';
            if (kind === 'future-time') native.finishedAt = new Date(Date.now() + 60000).toISOString();
            if (kind === 'source-receipt-drift') await saveQaJson(options.env.PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT, {sourceFiles: [], hashes: {}});
        });
        assert.equal(result.complete, false); assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'QA_NATIVE_RESULT_INCOMPLETE');
    });

test('managed legacy admission respects flag off before reading private metadata or opening SQL', async () => {
    const previous = process.env.NEUROCENTER_QA_POSTGRES; process.env.NEUROCENTER_QA_POSTGRES = '0';
    try { await assert.rejects(ownedConnection(path.join(sourceRoot, '.run/qa-postgres/11111111-1111-4111-8111-111111111111/connection.json')),
        error => error.code === 'QA_DISABLED'); }
    finally { if (previous === undefined) delete process.env.NEUROCENTER_QA_POSTGRES; else process.env.NEUROCENTER_QA_POSTGRES = previous; }
});
