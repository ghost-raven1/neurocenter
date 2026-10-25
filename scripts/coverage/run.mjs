#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, rm, stat} from 'node:fs/promises';
import {nativeSuites, integrationConfiguration, safeEnvironment, tapCounts, coverageCountersComplete} from './profiles.mjs';
import {sourceIdentity} from './source-identity.mjs';
import {reconcileTestFileInventory} from './test-file-inventory.mjs';
import {externalSuite, focusedSelection, reconcileFocusedSelection} from './focused-selection.mjs';
import {validateUnitSafeProfile} from './unit-safe-profile.mjs';
import {readVitestReport} from '../workspace/check-report.mjs';
import {ownedPgPackages, ownedPgConfiguration, startOwnedPg} from './owned-pg.mjs';
import {coverageMethod} from './methods.mjs';
import {coveragePackages, collectSourceInventory, reconcileSourceInventory, writeSourceInventory} from './source-inventory.mjs';
import {coverageHelp, parseCoverageOptions, assertCoverageLifecycleEnabled} from './options.mjs';
import {createRunLifecycle, failRunLifecycle, runLifecycleStep, saveRunManifest} from '../workspace/run-lifecycle.mjs';

export {parseCoverageOptions} from './options.mjs';
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('./package.json', import.meta.url));
const note = 'complete/suiteCompletion reports only the requested suites, never a near100 or all-module claim. --no-unit HTTP maps contain executed sources only. Unit profiles include never-imported production modules; potential infrastructure suites are conservatively excluded by imports/environment references, including some SQL-mocked units. Excluded test-case counts are not inferred from file counts. Explicit integration uses only caller-owned local fixtures, with original V8 data and skip counts retained. Coverage does not replace PostgreSQL constraint/trigger tests, browser, CI, deployment or production acceptance.';

async function files(folder) {
    let entries;
    try { entries = await readdir(folder, {withFileTypes: true}); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(folder, entry.name))
        : entry.isFile() ? [path.join(folder, entry.name)] : []))).flat().sort();
}

async function json(filename, invalidAsNull = false) {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || invalidAsNull && error instanceof SyntaxError) return null; throw error; }
}

function cancelled(manifest, signal) {
    if (!signal?.aborted) return false;
    manifest.lifecycle.cancellation = {signal: ['SIGINT', 'SIGTERM'].includes(signal.reason) ? signal.reason : null};
    failRunLifecycle(manifest.lifecycle, 'CANCELLED');
    return true;
}

/** Collect one unit package; retain valid test counters before parsing potentially broken coverage JSON. */
async function unitCoverage(context, [name, relative]) {
    const {root, options, folder: output, manifest, merged, libraries, selection, workers, fixture, execute, save, signal} = context;
    const cwd = path.join(root, relative), folder = path.join(output, name);
    await mkdir(folder);
    const excluded = [], testFiles = (await files(path.join(cwd, 'test'))).filter(file => /\.test\.[cm]?[jt]sx?$/.test(file));
    if (!options.ownedPg) for (const file of testFiles) if (await externalSuite(file)) excluded.push(path.relative(cwd, file).split(path.sep).join('/'));
    const excludedBySelection = selection ? testFiles.map(file => path.relative(cwd, file).split(path.sep).join('/'))
        .filter(file => !excluded.includes(file) && !selection.files.includes(file)).sort() : [];
    const reportFile = path.join(folder, 'test-results.json'), inventoryFile = path.join(folder, 'test-file-inventory.json');
    const command = ['node_modules/vitest/vitest.mjs', 'run', ...(selection?.files ?? []), '--coverage', '--maxWorkers=' + workers,
        ...(options.ownedPg ? ['--testTimeout=30000', '--hookTimeout=60000'] : []), '--reporter=json',
        '--reporter=' + path.join(root, 'scripts/coverage/inventory-reporter.mjs'), '--outputFile=' + reportFile,
        ...[...excluded, ...excludedBySelection].flatMap(file => ['--exclude', file])];
    context.output.write('COVERAGE_UNIT_START ' + name + '\n');
    const result = await runLifecycleStep(manifest.lifecycle, 'unit:' + name, {node: process.execPath, args: command, cwd,
        env: {...safeEnvironment(context.environment), ...fixture?.env, NEUROCENTER_COVERAGE_DIR: path.join(folder, 'report'),
            NEUROCENTER_COVERAGE_INVENTORY_FILE: inventoryFile}, logFile: path.join(folder, 'tests.log'),
        signal, timeoutMs: options.timeoutMs}, {save, ...(execute ? {execute} : {})});
    cancelled(manifest, signal);
    const tests = await json(reportFile, true);
    let reportValidation;
    try { reportValidation = readVitestReport(reportFile); }
    catch (error) { reportValidation = {ok: false, reportError: error.message}; }
    if (!result.ok && !reportValidation.tests) return;
    const testFileInventory = reconcileFocusedSelection(reconcileTestFileInventory({inventory: await json(inventoryFile, true),
        report: tests, cwd, excluded}), selection);
    const emptySelection = testFileInventory.expectedFileCount > 0 && !(tests?.numPassedTests + tests?.numFailedTests + tests?.numPendingTests);
    const entry = {name, root: relative, command: [process.execPath, ...command], exitCode: result.exitCode,
        passed: reportValidation.tests?.passed ?? null, failed: reportValidation.tests?.failed ?? null,
        skipped: reportValidation.tests?.skipped ?? null, todo: reportValidation.tests?.todo ?? null,
        emptySelection, testFileInventory, reportValidation,
        skippedTests: Array.isArray(tests?.testResults) ? tests.testResults.flatMap(suite => (Array.isArray(suite?.assertionResults) ? suite.assertionResults : [])
            .filter(test => ['skipped', 'pending'].includes(test?.status) && typeof suite.name === 'string')
            .map(test => ({file: path.relative(cwd, suite.name), title: test.fullName}))) : [],
        excludedInfrastructureSuites: excluded, ...(selection ? {requestedTestFiles: selection.files, excludedBySelection} : {})};
    manifest.packages.push(entry);
    if (emptySelection || !testFileInventory.complete || !reportValidation.ok) failRunLifecycle(manifest.lifecycle, 'TEST_REPORT_FAILED');
    await save();
    if (!result.ok || cancelled(manifest, signal)) return;
    const coverage = await json(path.join(folder, 'report/coverage-final.json'));
    if (!coverage || !Object.keys(coverage).length) failRunLifecycle(manifest.lifecycle, 'COVERAGE_EXECUTION_FAILED');
    if (coverage) merged.merge(coverage);
    const sourceFiles = (await files(path.join(cwd, 'src'))).filter(file => /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.d.cts'));
    const own = libraries.createCoverageMap(coverage || {});
    own.filter(file => file.startsWith(path.join(cwd, 'src') + path.sep));
    Object.assign(entry, {productionFiles: sourceFiles.map(file => path.relative(root, file)),
        unrepresentedFiles: sourceFiles.filter(file => !coverage?.[file]).map(file => path.relative(root, file)), ownSourceSummary: own.getCoverageSummary().toJSON()});
    context.output.write('COVERAGE_UNIT_DONE ' + name + ' exit=' + result.exitCode + ' passed=' + (entry.passed ?? 'unknown')
        + ' skipped=' + (entry.skipped ?? 'unknown') + ' todo=' + (entry.todo ?? 'unknown') + ' infrastructureExcluded=' + excluded.length + '\n');
    await save();
}

/** Native profiles keep their own TAP counts and c8 denominator, even when report conversion fails. */
async function nativeCoverage(context, profile) {
    const {root, options, manifest, merged, libraries, sourceSnapshot, execute, save, signal} = context;
    const folder = path.join(context.folder, profile.name), raw = path.join(folder, 'raw');
    await mkdir(raw, {recursive: true});
    const command = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...profile.suites.map(file => 'scripts/test/' + file)];
    context.output.write('COVERAGE_' + profile.name.toUpperCase() + '_START\n');
    const result = await runLifecycleStep(manifest.lifecycle, profile.name, {node: process.execPath, args: command, cwd: root,
        env: {...safeEnvironment(context.environment), ...profile.env, NODE_V8_COVERAGE: raw}, logFile: path.join(folder, 'tests.log'),
        signal, timeoutMs: options.timeoutMs}, {save, ...(execute ? {execute} : {})});
    cancelled(manifest, signal);
    const log = await readFile(path.join(folder, 'tests.log'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const counts = tapCounts(log);
    if (!result.ok && Object.values(counts).every(value => value === null)) return;
    manifest[profile.name] = {command: [process.execPath, ...command], exitCode: result.exitCode, ...counts, suites: profile.suites,
        excludedSuites: profile.excludedSuites, fixture: profile.fixture ?? null, remapping: 'c8@10.1.3 source maps; original raw/native/unit reports retained'};
    if (counts.passed === null) failRunLifecycle(manifest.lifecycle, 'TEST_REPORT_FAILED');
    await save();
    const rawFiles = await files(raw);
    let rawBytes = 0;
    for (const file of rawFiles) rawBytes += (await stat(file)).size;
    Object.assign(manifest[profile.name], {rawFiles: rawFiles.length, rawBytes});
    await save();
    if (!result.ok || cancelled(manifest, signal)) return;
    if (rawBytes > 512 * 1024 ** 2) throw Error('Native coverage exceeded the 512MiB report budget.');
    if (cancelled(manifest, signal)) return;
    const includes = sourceSnapshot.files.filter(file => file.role === 'production' && file.instrumentable).map(file => path.join(root, file.path));
    const report = new libraries.Report({tempDirectory: raw, reportsDirectory: folder, reporter: ['json', 'json-summary', 'lcov', 'html'],
        include: includes, exclude: ['**/node_modules/**', '**/*.d.ts', '**/*.d.cts', '**/test-coverage.mjs'], excludeAfterRemap: true,
        extension: ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'], resolve: root, allowExternal: true, all: false, excludeNodeModules: true, src: [], skipFull: false});
    await report.run();
    if (cancelled(manifest, signal)) return;
    const coverage = await json(path.join(folder, 'coverage-final.json'));
    if (!coverage || !Object.keys(coverage).length) failRunLifecycle(manifest.lifecycle, 'COVERAGE_EXECUTION_FAILED');
    if (coverage) merged.merge(coverage);
    context.output.write('COVERAGE_' + profile.name.toUpperCase() + '_DONE exit=' + result.exitCode + ' sources=' + Object.keys(coverage || {}).length + '\n');
    await save();
}

/** Execute one admitted coverage plan with an initial receipt, owned processes and terminal finalization. */
export async function runCoverage(options, {root = workspace, signal, environment = process.env, output = process.stdout,
    errorOutput = process.stderr, execute, fixtureStart = startOwnedPg} = {}) {
    assertCoverageLifecycleEnabled(environment);
    if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Coverage baseline requires the configured Node24 toolchain.');
    if (process.platform === 'win32') throw Error('Coverage with managed process cleanup requires POSIX.');
    const {chosen, requestedTestFiles, unit, native, integration, ownedPg, maxWorkers} = options;
    const selection = await focusedSelection({root, packages: coveragePackages, chosen, testFiles: requestedTestFiles, unit, native, integration, ownedPg});
    if (unit && !ownedPg) await validateUnitSafeProfile(root, {packages: coveragePackages, chosen, testFiles: requestedTestFiles});
    const integrationConfig = integration ? await integrationConfiguration(environment, root) : null;
    const ownedPgConfig = ownedPg ? await ownedPgConfiguration(environment, root) : null;
    const selectedPackages = coveragePackages.filter(([name]) => unit && (!ownedPg || ownedPgPackages.includes(name)) && (!chosen.size || chosen.has(name)));
    const profiles = [native ? {name: 'native', suites: nativeSuites, env: {}, excludedSuites: []} : null,
        integrationConfig ? {name: 'integration', ...integrationConfig} : null].filter(Boolean);
    const lifecycle = createRunLifecycle([...selectedPackages.map(([name]) => 'unit:' + name), ...profiles.map(profile => profile.name)]);
    const folder = options.output ?? path.join(root, '.run/coverage', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
    await mkdir(path.dirname(folder), {recursive: true});
    await mkdir(folder, {recursive: false});
    const workers = ownedPg ? 1 : maxWorkers, method = coverageMethod([unit ? 'vitest-ast-v8' : 'native-c8-v8']);
    const manifest = {schemaVersion: 2, profile: [unit ? ownedPg ? 'owned-pg' : 'unit-safe' : null, native ? 'native-http' : null,
        integration ? 'owned-integration' : null].filter(Boolean).join('+'), ...method, startedAt: new Date().toISOString(), node: process.version,
        complete: false, suiteCompletion: false, lifecycle, sourceBefore: null, sourceAfter: null, sourceChangedDuringRun: null,
        packages: [], native: null, integration: null, ownedPg: null,
        limits: {maxWorkers: workers, httpConcurrency: 1, externalDatabases: integration || ownedPg,
            externalObjectStorage: !!(integrationConfig?.fixture.storage || ownedPgConfig?.fixture.storage), priceEstimates: false,
            timeoutMsPerProcess: options.timeoutMs, totalDeadline: false}, note};
    if (selection) {
        manifest.requestedTestFiles = selection.files;
        manifest.scope = {package: selection.package, completion: 'requested-selection-only', testSelection: 'exact-files', sourceDenominator: 'entire-selected-package-source'};
    }
    const filename = path.join(folder, 'manifest.json');
    const save = async () => { manifest.updatedAt = new Date().toISOString(); await saveRunManifest(filename, manifest); };
    let fixture, sourceSnapshot, merged, libraries, gapsAttempted = false;
    const discardFailedGaps = async () => {
        if (!gapsAttempted || !lifecycle.failure && !lifecycle.cancellation) return;
        for (const name of ['gaps.json', 'gaps.md']) {
            try { await rm(path.join(folder, name), {force: true}); }
            catch { failRunLifecycle(lifecycle, 'COVERAGE_FINALIZATION_FAILED', {finalization: true}); }
        }
    };
    try {
        await save();
        if (!cancelled(manifest, signal)) {
            manifest.sourceBefore = sourceIdentity(root);
            sourceSnapshot = await collectSourceInventory(root);
            manifest.sourceInventory = reconcileSourceInventory(sourceSnapshot, [], root, method.coverageKind);
            libraries = {...require('istanbul-lib-coverage'), ...require('istanbul-lib-report'), reports: require('istanbul-reports'), ...require('c8'),
                ...(await import('./report.mjs'))};
            merged = libraries.createCoverageMap({});
            await save();
            if (ownedPg && !cancelled(manifest, signal)) {
                fixture = await fixtureStart(ownedPgConfig);
                manifest.ownedPg = fixture.fixture;
                await save();
            }
            const context = {root, options, folder, manifest, merged, libraries, selection, workers, fixture, execute, save, signal, output, environment, sourceSnapshot};
            for (const entry of selectedPackages) {
                if (cancelled(manifest, signal) || lifecycle.failure) break;
                await unitCoverage(context, entry);
            }
            for (const profile of profiles) {
                if (cancelled(manifest, signal) || lifecycle.failure) break;
                await nativeCoverage(context, profile);
            }
        }
    } catch {
        failRunLifecycle(lifecycle, 'COVERAGE_EXECUTION_FAILED');
    } finally {
        lifecycle.state = 'finalizing';
        try { await save(); } catch { failRunLifecycle(lifecycle, 'COVERAGE_FINALIZATION_FAILED', {finalization: true}); }
        if (fixture) {
            try { await fixture.close(); manifest.ownedPg.cleaned = true; }
            catch {
                manifest.ownedPg.cleaned = false;
                manifest.ownedPg.cleanupError = 'Owned fallback database cleanup failed; no FORCE or unrelated database cleanup was attempted.';
                failRunLifecycle(lifecycle, 'COVERAGE_FINALIZATION_FAILED', {finalization: true});
            }
        }
        try {
            if (!cancelled(manifest, signal) && merged && merged.files().length > 0) {
                await mkdir(path.join(folder, 'merged'), {recursive: true});
                const context = libraries.createContext({dir: path.join(folder, 'merged'), coverageMap: merged});
                for (const name of ['json', 'json-summary', 'lcov', 'html']) {
                    if (cancelled(manifest, signal)) break;
                    libraries.reports.create(name, {skipEmpty: false, skipFull: false}).execute(context);
                }
                manifest.sourceInventory = reconcileSourceInventory(sourceSnapshot, merged.files(), root, method.coverageKind);
                manifest.denominator = {allWorkspaceSourcesIncluded: manifest.sourceInventory.allProductionSourcesRepresented,
                    configuredPackageSourcesIncluded: unit && !ownedPg && (!chosen.size || chosen.size === coveragePackages.length),
                    ...(selection ? {selectedPackageSourcesIncluded: manifest.packages.length === 1 && manifest.packages.every(item => item.productionFiles.length > 0 && !item.unrepresentedFiles.length)} : {}),
                    allSourcePackages: manifest.packages.map(item => item.name), httpOnlyExecutedSources: true,
                    inventoryFile: 'source-inventory.json', fileInventoryIsNotLineCoverage: true};
                manifest.summary = merged.getCoverageSummary().toJSON();
                manifest.sourceFiles = merged.files().length;
                manifest.sourceAfter = sourceIdentity(root);
                manifest.sourceChangedDuringRun = JSON.stringify(manifest.sourceBefore) !== JSON.stringify(manifest.sourceAfter);
                if (manifest.sourceChangedDuringRun) failRunLifecycle(lifecycle, 'SOURCE_CHANGED');
                if (lifecycle.failure) await writeSourceInventory(manifest.sourceInventory, folder);
                if (!cancelled(manifest, signal) && !lifecycle.failure) {
                    // Only the final atomic manifest publishes completion; a partial gaps file cannot establish it.
                    const candidate = {...manifest, lifecycle: {...lifecycle, state: 'passed'}};
                    candidate.complete = candidate.suiteCompletion = coverageCountersComplete(candidate);
                    gapsAttempted = true;
                    await libraries.writeGapReport(merged, candidate, folder);
                }
            }
            if (manifest.sourceBefore) {
                manifest.sourceAfter = sourceIdentity(root);
                manifest.sourceChangedDuringRun = JSON.stringify(manifest.sourceBefore) !== JSON.stringify(manifest.sourceAfter);
                if (manifest.sourceChangedDuringRun) failRunLifecycle(lifecycle, 'SOURCE_CHANGED');
            }
        } catch { failRunLifecycle(lifecycle, 'COVERAGE_FINALIZATION_FAILED', {finalization: true}); }
        cancelled(manifest, signal);
        await discardFailedGaps();
        lifecycle.state = lifecycle.cancellation ? 'cancelled' : lifecycle.failure ? 'failed' : 'passed';
        manifest.complete = manifest.suiteCompletion = lifecycle.state === 'passed' && coverageCountersComplete(manifest);
        manifest.finishedAt = new Date().toISOString();
        try {
            await save();
            if (cancelled(manifest, signal) && lifecycle.state !== 'cancelled') {
                lifecycle.state = 'cancelled';
                manifest.complete = manifest.suiteCompletion = false;
                await discardFailedGaps();
                await save();
            }
        }
        catch {
            failRunLifecycle(lifecycle, 'COVERAGE_FINALIZATION_FAILED', {finalization: true});
            manifest.complete = manifest.suiteCompletion = false;
            lifecycle.state = lifecycle.cancellation ? 'cancelled' : 'failed';
            await discardFailedGaps();
            try { await save(); } catch { errorOutput.write('Coverage receipt could not be finalized; saved state is incomplete.\n'); }
        }
    }
    output.write('COVERAGE_REPORT ' + filename + '\n');
    return {manifest, report: filename, exitCode: lifecycle.state === 'passed' ? 0
        : lifecycle.state === 'cancelled' ? lifecycle.cancellation.signal === 'SIGTERM' ? 143 : 130 : 1};
}

/** Help and invalid flags finish before runtime checks, signal handlers, evidence directories or subprocesses. */
export async function main(args, {environment = process.env, output = process.stdout, ...execution} = {}) {
    const options = parseCoverageOptions(args, environment);
    if (options.help) { output.write(coverageHelp + '\n'); return 0; }
    const controller = new AbortController(), interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    try { return (await runCoverage(options, {...execution, environment, output, signal: controller.signal})).exitCode; }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try { process.exitCode = await main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
