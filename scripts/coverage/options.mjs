import path from 'node:path';
import {coveragePackages} from './source-inventory.mjs';
import {ownedPgPackages} from './owned-pg.mjs';

export const coverageHelp = 'Node24: node scripts/coverage/run.mjs [--package <id>] [--test-file <test/relative.test.ts>] [--native] [--integration] [--owned-pg] [--no-unit] [--max-workers <1|2>] [--timeout-ms <positive-integer>] [--output <new-directory>]. Default: all8 unit-safe suites, two workers; use one on constrained hosts. Repeat --test-file up to 32 times with one package for exact unit-safe selection. Owned-PG always uses one worker with explicit owned PostgreSQL+S3. Native/integration: retained HTTP coverage. Timeout is per subprocess (default 600000ms); filesystem finalization has no total deadline. NEUROCENTER_COVERAGE_LIFECYCLE=0 disables new execution; saved evidence remains readable.';

/** The execution flag never gates help or reading retained reports. */
export function assertCoverageLifecycleEnabled(environment) {
    if (environment.NEUROCENTER_COVERAGE_LIFECYCLE !== undefined && !['0', '1'].includes(environment.NEUROCENTER_COVERAGE_LIFECYCLE))
        throw Error('NEUROCENTER_COVERAGE_LIFECYCLE must be 0 or 1.');
    if (environment.NEUROCENTER_COVERAGE_LIFECYCLE === '0') throw Error('NEUROCENTER_COVERAGE_LIFECYCLE=0 disables new coverage runs.');
}

/** Admit flags and selectors before creating evidence, loading collectors, or starting any process. */
export function parseCoverageOptions(args, environment = process.env) {
    if (args.length === 1 && args[0] === '--help') return {help: true};
    const options = {chosen: new Set(), requestedTestFiles: [], native: false, integration: false, ownedPg: false,
        unit: true, output: undefined, maxWorkers: 2, timeoutMs: 600000};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--native') options.native = true;
        else if (arg === '--integration') options.integration = true;
        else if (arg === '--owned-pg') options.ownedPg = true;
        else if (arg === '--no-unit') options.unit = false;
        else if (arg === '--max-workers') {
            const value = args[++i];
            if (!['1', '2'].includes(value)) throw Error('--max-workers must be 1 or 2.');
            options.maxWorkers = Number(value);
        } else if (arg === '--timeout-ms') {
            const value = args[++i];
            if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw Error('--timeout-ms must be a positive safe integer.');
            options.timeoutMs = Number(value);
        } else if (arg === '--package') {
            const name = args[++i];
            if (!coveragePackages.some(([id]) => id === name)) throw Error('Unknown coverage package: ' + name);
            options.chosen.add(name);
        } else if (arg === '--test-file') {
            if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('--test-file requires a test/<relative>.test file.');
            options.requestedTestFiles.push(args[++i]);
        } else if (arg === '--output') {
            if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('--output requires a new directory.');
            options.output = path.resolve(args[++i]);
        } else throw Error('Unknown coverage option: ' + arg);
    }
    assertCoverageLifecycleEnabled(environment);
    if (!options.unit && !options.native && !options.integration) throw Error('--no-unit requires --native or --integration.');
    if (options.unit && (options.native || options.integration)) throw Error('Keep Vitest AST and native c8 runs separate; combine comparable AST reports with merge.mjs.');
    if (options.ownedPg && (!options.unit || [...options.chosen].some(name => !ownedPgPackages.includes(name))))
        throw Error('--owned-pg runs only Catalog/RAG/flags full unit suites.');
    return options;
}
