import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {listEvidence, evidenceDigest} from '../dev-mcp/evidence-catalog.mjs';
import {verifySource} from '../dev-mcp/verify-source.mjs';
import {readRunSummary} from '../dev-mcp/run-reports.mjs';
import {createDiagnostics} from '../dev-mcp/diagnostics.mjs';
import {captureCheckSource, checkSourceResult} from '../workspace/check-source.mjs';
import {sourceSnapshot} from '../workspace/isolated-build-source.mjs';

const startedAt = '2026-10-25T01:00:00.000Z', finishedAt = '2026-10-25T01:01:00.000Z';
const checkPath = '.run/check/fixture/report.json', buildPath = '.run/isolated-build/fixture/receipt.json';
const compact = snapshot => ({head: snapshot.head, sha256: snapshot.digest, files: snapshot.files, bytes: snapshot.bytes,
    newFiles: snapshot.newFiles, deleted: snapshot.deleted, exclusions: Object.keys(snapshot.excluded).length});

/** Private Git fixtures contain no compiler, installed dependency, service, runtime or model invocation. */
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-mcp-evidence-')));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({name: 'neurocenter-workspace', scripts: {build: 'NEVER_EXECUTE_THIS_COMMAND'}}));
    await fs.writeFile(path.join(root, '.gitignore'), '.run/\nnode_modules/\n');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'original'); await fs.writeFile(path.join(root, 'delete.txt'), 'retained');
    await fs.writeFile(path.join(root, '.env'), 'PRIVATE_CONFIGURATION_FIXTURE');
    const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd: root, encoding: 'utf8',
        env: {PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'}}).trim();
    git(['init', '-q', '-b', 'main']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
    const head = git(['rev-parse', 'HEAD']);
    const save = async (report, value) => { await fs.mkdir(path.dirname(path.join(root, report)), {recursive: true});
        const text = typeof value === 'string' ? value : JSON.stringify(value); await fs.writeFile(path.join(root, report), text); return evidenceDigest(text); };
    const readSummary = report => readRunSummary(root, report, {available: true, head, dirty: {clean: true}});
    const check = async (report = checkPath) => {
        const captured = await captureCheckSource(root);
        const value = {schemaVersion: 3, selection: {packages: ['frontend'], steps: ['typecheck']}, state: 'passed', startedAt, finishedAt,
            updatedAt: finishedAt, success: true, failure: null, cancellation: null, source: checkSourceResult(captured, captured),
            plannedSteps: ['frontend: typecheck'], steps: [{name: 'frontend: typecheck', ok: true, exitCode: 0, signal: null, durationMs: 1,
                leaderReaped: true, cleanup: {noLiveDescendants: true, zombieCount: 0, signals: []}}], privateLog: 'PRIVATE_RAW_LOG_FIXTURE'};
        return {value, hash: await save(report, value), report};
    };
    const build = async () => {
        const snapshot = await sourceSnapshot(root), hash = 'b'.repeat(64);
        const value = {schemaVersion: 1, selectedPackages: ['frontend'], startedAt, finishedAt, status: 'built-current-snapshot', ok: true,
            inputs: compact(snapshot), sourceCurrent: true, candidateInputsUnchanged: true, liveOutputsUnchanged: true, dependencyLinksUnchanged: true,
            primaryFailure: null, finalizationErrors: [], builds: [{id: 'frontend', ok: true, exitCode: 0, signal: null, durationMs: 1,
                leaderReaped: true, cleanup: {noLiveDescendants: true}, artifacts: {files: 1, bytes: 10, sha256: hash, requiredEntry: 'index.html', requiredEntryPresent: true},
                log: {bytes: 10, hashedBytes: 10, complete: true, sha256Scope: 'complete-file', sha256: hash}}]};
        const reportHash = await save(buildPath, value); await save('.run/isolated-build/fixture/source-copied.json', snapshot);
        return {value, hash: reportHash, snapshot, report: buildPath};
    };
    return {root, git, save, readSummary, check, build,
        verify: (item, options = {}) => verifySource(root, {report: item.report, expectedReportSha256: item.hash}, {readSummary, ...options})};
}

test('Catalog returns only validated report scope, SHA and times without raw commands or logs', async t => {
    const f = await fixture(t); await f.check(); await f.build();
    const report = '.run/coverage/fixture/manifest.json', metric = {total: 1, covered: 1, pct: 100};
    await f.save(report, {schemaVersion: 2, profile: 'unit-safe', startedAt, finishedAt, complete: false, packages: [], native: null,
        integration: null, sourceChangedDuringRun: false, summary: {lines: metric, statements: metric, functions: metric, branches: metric}});
    const diagnostics = await createDiagnostics(f.root);
    const catalog = await listEvidence(f.root, {}, {readSummary: item => item === report ? diagnostics.verificationSummary(item) : f.readSummary(item)});
    assert.equal(catalog.entries.length, 3); assert.equal(catalog.scan.complete, true); assert.equal(catalog.scan.truncated, false);
    assert.deepEqual(catalog.entries.map(item => item.family), ['check', 'coverage', 'isolated-build']);
    const check = catalog.entries[0]; assert.equal(check.state, 'available'); assert.match(check.reportSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(check.countScope, {kind: 'check', packages: ['frontend'], steps: ['typecheck'], tooling: false, profile: null, reportedOnly: true});
    assert.equal(check.startedAt, startedAt); assert.equal(check.finishedAt, finishedAt);
    const visible = JSON.stringify(catalog);
    for (const privateText of ['NEVER_EXECUTE', 'PRIVATE_RAW_LOG', 'PRIVATE_CONFIGURATION']) assert.equal(visible.includes(privateText), false);
});

test('One malformed, linked or oversized report is rejected separately without hiding valid history', async t => {
    const f = await fixture(t), original = await f.check();
    await f.save('.run/check/malformed/report.json', '{invalid');
    await f.save('.run/check/oversized/report.json', 'x'.repeat(1024 ** 2 + 1));
    for (const name of ['symbolic', 'hardlink']) await fs.mkdir(path.join(f.root, '.run/check', name));
    await fs.symlink(path.join(f.root, checkPath), path.join(f.root, '.run/check/symbolic/report.json'));
    const privateFile = path.join(f.root, '.run/other.json'); await fs.writeFile(privateFile, JSON.stringify(original.value));
    await fs.link(privateFile, path.join(f.root, '.run/check/hardlink/report.json'));
    const result = await listEvidence(f.root, {families: ['check'], limit: 20}, {readSummary: f.readSummary});
    assert.equal(result.entries.filter(item => item.state === 'available').length, 1);
    const rejected = result.entries.filter(item => item.state === 'rejected');
    assert.equal(rejected.filter(item => item.reason === 'UNSAFE_REPORT').length, 2);
    assert.ok(rejected.some(item => item.reason === 'MALFORMED_REPORT')); assert.ok(rejected.some(item => item.reason === 'REPORT_TOO_LARGE'));
});

test('Catalog never follows a symlinked family or canonical run directory', async t => {
    const f = await fixture(t), foreign = path.join(f.root, 'foreign'); await fs.mkdir(foreign);
    await fs.mkdir(path.join(f.root, '.run')); await fs.symlink(foreign, path.join(f.root, '.run/check'));
    let calls = 0;
    let result = await listEvidence(f.root, {families: ['check']}, {readSummary: async () => { calls++; }});
    assert.deepEqual(result.scan.rejectedFamilies, [{family: 'check', reason: 'UNSAFE_REPORT'}]); assert.equal(calls, 0);
    await fs.rm(path.join(f.root, '.run/check')); await fs.mkdir(path.join(f.root, '.run/check'));
    await fs.symlink(foreign, path.join(f.root, '.run/check/linked'));
    result = await listEvidence(f.root, {families: ['check']}, {readSummary: async () => { calls++; }});
    assert.equal(result.entries[0].reason, 'UNSAFE_REPORT'); assert.equal(calls, 0);
});

test('A replaced report parent is rejected even when replacement bytes have the same SHA', async t => {
    const f = await fixture(t), item = await f.check();
    const readSummary = async report => {
        const summary = await f.readSummary(report), folder = path.dirname(path.join(f.root, report));
        await fs.rename(folder, folder + '-old'); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(item.value));
        return summary;
    };
    const result = await listEvidence(f.root, {families: ['check']}, {readSummary});
    assert.equal(result.entries[0].state, 'rejected'); assert.equal(result.entries[0].reason, 'REPORT_CHANGED'); assert.equal(result.scan.complete, false);
});

test('Catalog entry and filesystem scan limits are explicit and never described as latest', async t => {
    const f = await fixture(t), first = await f.check();
    for (let index = 0; index < 4; index++) await f.save('.run/check/run-' + index + '/report.json', first.value);
    let result = await listEvidence(f.root, {families: ['check'], limit: 2}, {readSummary: f.readSummary});
    assert.equal(result.entries.length, 2); assert.equal(result.scan.truncated, true); assert.equal(result.scan.complete, false);
    assert.equal(JSON.stringify(result).includes('latest'), false);
    await fs.rm(path.join(f.root, '.run/check'), {recursive: true}); await fs.mkdir(path.join(f.root, '.run/check'));
    for (let index = 0; index < 130; index++) await fs.writeFile(path.join(f.root, '.run/check', 'ignored-' + index), 'ordinary non-run file');
    result = await listEvidence(f.root, {families: ['check'], limit: 20}, {readSummary: f.readSummary});
    assert.equal(result.scan.scannedEntries, 128); assert.equal(result.scan.truncated, true); assert.equal(result.entries.length, 0);
});

test('Check v3 matches current retained inputs while recorded pass and source comparison remain separate', async t => {
    const f = await fixture(t), item = await f.check();
    let result = await f.verify(item);
    assert.equal(result.recorded.status, 'requested-steps-complete'); assert.equal(result.recorded.complete, true); assert.equal(result.comparison.state, 'match');
    assert.equal(result.comparison.scope, 'check-v3-recorded-after'); assert.equal(result.comparison.currentSource.sha256, item.value.source.after.sha256);
    await fs.writeFile(path.join(f.root, 'tracked.txt'), 'changed'); result = await f.verify(item);
    assert.equal(result.comparison.state, 'mismatch'); assert.equal(result.recorded.complete, true);
    assert.equal((await f.readSummary(item.report)).source.currentSourceEquivalent, 'unknown');
});

for (const change of ['new', 'deleted', 'tracked-metadata']) test('Source comparison includes ' + change + ' inputs without relying only on HEAD', async t => {
    const f = await fixture(t);
    if (change === 'tracked-metadata') await fs.writeFile(path.join(f.root, 'new.txt'), 'same bytes');
    const item = await f.check();
    if (change === 'new') await fs.writeFile(path.join(f.root, 'new.txt'), 'new');
    else if (change === 'deleted') await fs.rm(path.join(f.root, 'delete.txt'));
    else f.git(['add', 'new.txt']);
    const result = await f.verify(item);
    assert.equal(result.comparison.state, 'mismatch'); assert.equal(result.comparison.currentSource.head, item.value.source.after.head);
    assert.equal(result.recorded.complete, true);
});

test('A failed recorded check can match current source without becoming a passed report', async t => {
    const f = await fixture(t), item = await f.check();
    Object.assign(item.value, {state: 'failed', success: false, failure: {code: 'CHECK_FAILED'}});
    Object.assign(item.value.steps[0], {ok: false, exitCode: 1}); item.hash = await f.save(item.report, item.value);
    const result = await f.verify(item);
    assert.equal(result.recorded.status, 'failed'); assert.equal(result.recorded.complete, false); assert.equal(result.comparison.state, 'match');
});

test('Stale expected report SHA and a concurrent report replacement never retain a pass claim', async t => {
    const f = await fixture(t), item = await f.check();
    let result = await f.verify({...item, hash: 'a'.repeat(64)});
    assert.equal(result.comparison.reason, 'REPORT_CHANGED'); assert.equal(result.recorded.complete, null);
    result = await f.verify(item, {readSummary: async report => {
        const summary = await f.readSummary(report); await f.save(report, {...item.value, privateExtra: 'changed'}); return summary;
    }});
    assert.equal(result.comparison.state, 'unknown'); assert.equal(result.comparison.reason, 'REPORT_CHANGED'); assert.equal(result.recorded.status, null);
});

test('Malformed or unsafe explicitly selected reports produce bounded unknown observations', async t => {
    const f = await fixture(t), item = await f.check();
    item.hash = await f.save(item.report, '{malformed');
    assert.equal((await f.verify(item)).comparison.reason, 'MALFORMED_REPORT');
    await fs.rm(path.join(f.root, item.report)); await fs.symlink(path.join(f.root, 'tracked.txt'), path.join(f.root, item.report));
    assert.equal((await f.verify(item)).comparison.reason, 'UNSAFE_REPORT');
});

test('Coverage and legacy check protocols stay unknown without inventing a new current capture', async t => {
    const f = await fixture(t), item = await f.check();
    item.value.schemaVersion = 2; for (const key of ['source', 'failure', 'cancellation']) delete item.value[key];
    item.hash = await f.save(item.report, item.value); await fs.rm(path.join(f.root, '.git'), {recursive: true});
    let result = await f.verify(item); assert.equal(result.comparison.reason, 'UNSUPPORTED_SOURCE_PROTOCOL'); assert.equal(result.comparison.currentSource, null);
    const report = '.run/coverage/legacy/manifest.json', hash = await f.save(report, '{}');
    result = await verifySource(f.root, {report, expectedReportSha256: hash}, {readSummary: async () => ({report, reportSha256: hash, status: 'incomplete', complete: false})});
    assert.equal(result.comparison.reason, 'UNSUPPORTED_SOURCE_PROTOCOL');
});

test('Isolated build compares its bounded retained source inventory including new and deleted entries', async t => {
    const f = await fixture(t), item = await f.build();
    let result = await f.verify(item); assert.equal(result.comparison.state, 'match'); assert.equal(result.comparison.scope, 'isolated-build-source-snapshot');
    await fs.rm(path.join(f.root, 'delete.txt')); result = await f.verify(item);
    assert.equal(result.comparison.state, 'mismatch'); assert.equal(result.recorded.status, 'built-snapshot'); assert.equal(result.recorded.complete, true);
});

test('Excluded private configuration contents and ignored dependencies are explicitly outside source comparison', async t => {
    const f = await fixture(t), check = await f.check(), build = await f.build();
    await fs.writeFile(path.join(f.root, '.env'), 'CHANGED_PRIVATE_CONFIGURATION');
    await fs.mkdir(path.join(f.root, 'node_modules')); await fs.writeFile(path.join(f.root, 'node_modules/mutable.js'), 'changed');
    for (const item of [check, build]) {
        const result = await f.verify(item); assert.equal(result.comparison.state, 'match'); assert.match(result.limits.join(' '), /dependencies/);
        assert.equal(JSON.stringify(result).includes('CHANGED_PRIVATE_CONFIGURATION'), false);
    }
});

test('Missing, malformed or linked retained source metadata cannot establish isolated build applicability', async t => {
    const f = await fixture(t), item = await f.build(), metadata = path.join(f.root, '.run/isolated-build/fixture/source-copied.json');
    await fs.rm(metadata); assert.equal((await f.verify(item)).comparison.reason, 'RETAINED_SOURCE_UNAVAILABLE');
    await fs.writeFile(metadata, '{bad'); assert.equal((await f.verify(item)).comparison.reason, 'RETAINED_SOURCE_INVALID');
    await fs.rm(metadata); await fs.symlink(path.join(f.root, 'tracked.txt'), metadata);
    assert.equal((await f.verify(item)).comparison.reason, 'RETAINED_SOURCE_INVALID');
});

test('A changed retained inventory during observation is unknown even when the report SHA stays fixed', async t => {
    const f = await fixture(t), item = await f.build(), metadata = path.join(f.root, '.run/isolated-build/fixture/source-copied.json');
    const result = await f.verify(item, {readSummary: async report => {
        const summary = await f.readSummary(report), inputs = summary.inputs; let reads = 0;
        Object.defineProperty(summary, 'inputs', {get() { if (++reads === 2) writeFileSync(metadata, JSON.stringify({...item.snapshot, extra: 'changed'})); return inputs; }});
        return summary;
    }});
    assert.equal(result.comparison.reason, 'RETAINED_SOURCE_CHANGED'); assert.equal(result.comparison.state, 'unknown'); assert.equal(result.recorded.complete, true);
});

test('Unavailable Git, unsafe current source and cancellation never become source mismatch guesses', async t => {
    const f = await fixture(t), item = await f.check();
    await fs.symlink(path.join(f.root, 'tracked.txt'), path.join(f.root, 'source-link'));
    assert.equal((await f.verify(item)).comparison.reason, 'CURRENT_SOURCE_UNSAFE'); await fs.rm(path.join(f.root, 'source-link'));
    await fs.rm(path.join(f.root, '.git'), {recursive: true}); assert.equal((await f.verify(item)).comparison.reason, 'CURRENT_SOURCE_UNAVAILABLE');
    const controller = new AbortController(); controller.abort();
    assert.equal((await f.verify(item, {signal: controller.signal})).comparison.reason, 'CANCELLED');
});

test('Invalid selectors are rejected before enumeration or source observation', async t => {
    const f = await fixture(t), readSummary = async () => { throw Error('Must not read'); };
    for (const options of [{limit: 0}, {limit: 21}, {families: ['check', 'check']}, {families: ['qa-postgres']}, {families: []}, {limit: 1, command: 'bad'}])
        await assert.rejects(listEvidence(f.root, options, {readSummary}), {code: 'INVALID_ARGUMENT'});
    for (const options of [{report: '../secret.json', expectedReportSha256: 'a'.repeat(64)}, {report: checkPath, expectedReportSha256: 'bad'}])
        await assert.rejects(verifySource(f.root, options, {readSummary}), {code: 'INVALID_ARGUMENT'});
    await assert.rejects(fs.stat(path.join(f.root, '.run')), {code: 'ENOENT'});
});

test('Expected report hashes bind actual FD bytes even when UTF8 decoding would normalize different bytes', async t => {
    const f = await fixture(t), item = await f.check(), filename = path.join(f.root, item.report);
    const text = JSON.stringify({...item.value, privateLog: 'BYTE_MARKER'}), split = text.split('BYTE_MARKER');
    const raw = value => Buffer.concat([Buffer.from(split[0]), Buffer.from([value]), Buffer.from(split[1])]);
    const first = raw(0xff), second = raw(0xfe); await fs.writeFile(filename, first); item.hash = evidenceDigest(first);
    assert.notEqual(item.hash, evidenceDigest(first.toString('utf8')));
    assert.equal((await f.verify(item)).comparison.state, 'match');
    const result = await f.verify(item, {readSummary: async report => { const summary = await f.readSummary(report); await fs.writeFile(filename, second); return summary; }});
    assert.equal(first.toString('utf8'), second.toString('utf8'));
    assert.equal(result.comparison.reason, 'REPORT_CHANGED'); assert.equal(result.recorded.complete, null);
});

test('Catalog cancellation inside the first summary stops before another report read or a second entry', async t => {
    const f = await fixture(t), item = await f.check(); await f.save('.run/check/second/report.json', item.value);
    const controller = new AbortController(), originalOpen = fs.open;
    let summaries = 0, readsAfterAbort = 0;
    fs.open = async (...args) => { if (controller.signal.aborted) readsAfterAbort++; return originalOpen(...args); };
    syncBuiltinESMExports();
    try {
        await assert.rejects(listEvidence(f.root, {families: ['check'], limit: 20}, {signal: controller.signal,
            readSummary: async report => { summaries++; const summary = await f.readSummary(report); controller.abort(); return summary; }}), {code: 'CANCELLED'});
        assert.equal(summaries, 1); assert.equal(readsAfterAbort, 0);
    } finally { fs.open = originalOpen; syncBuiltinESMExports(); }
});

test('Catalog accepts the five-phase scope and lint receipt without changing historical report semantics',async t=>{
    const f=await fixture(t),{value}=await f.check();
    value.selection.steps=['lint','format:check','typecheck','build','test'];
    value.plannedSteps=value.selection.steps.map(step=>'frontend: '+step);
    const process=value.steps[0];
    value.steps=value.plannedSteps.map(name=>({...process,name,...(name.endsWith(': test')?{tests:{passed:1,failed:0,skipped:0,todo:0}}:{})}));
    await f.save(checkPath,value);
    const result=await listEvidence(f.root,{families:['check']},{readSummary:f.readSummary});
    assert.equal(result.entries[0].state,'available');
    assert.deepEqual(result.entries[0].countScope.steps,value.selection.steps);
});
