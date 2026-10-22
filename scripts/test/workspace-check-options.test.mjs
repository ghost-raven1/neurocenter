import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {workspacePackages} from '../workspace/check-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageId = directory => directory === 'mcp/neurocenter-asset-sync' ? 'bridge' : path.posix.basename(directory);

/** Run the real CLI against an owned checkout; intercept every child before it can execute. */
async function fixture(t, args, {withPackages = true, packageFolders = workspacePackages} = {}) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter check options ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const checkout = path.join(directory, 'checkout'), workspace = path.join(checkout, 'scripts/workspace');
    const callsFile = path.join(directory, 'calls.jsonl'), npm = path.join(directory, 'npm-cli.js');
    await fs.mkdir(workspace, {recursive: true});
    for (const name of ['check.mjs', 'check-plan.mjs', 'check-report.mjs', 'node-runtime.mjs']) {
        await fs.copyFile(path.join(root, 'scripts/workspace', name), path.join(workspace, name));
    }
    if (withPackages) for (const folder of packageFolders) {
        await fs.mkdir(path.join(checkout, folder), {recursive: true});
        await fs.writeFile(path.join(checkout, folder, 'package.json'), JSON.stringify({scripts: {
            typecheck: 'fixture', build: 'fixture', ...(['frontend', 'bridge'].includes(packageId(folder)) ? {test: 'vitest run'} : {}),
        }}));
    }
    for (const folder of ['scripts/test', 'scripts/catalog-plugins/test', 'scripts/catalog-plugins/recipes/test', 'scripts/agent-kit/test']) {
        await fs.mkdir(path.join(checkout, folder), {recursive: true});
    }
    await fs.writeFile(npm, '');
    const preload = path.join(directory, 'intercept.mjs');
    await fs.writeFile(preload, `import child from 'node:child_process';
        import fs from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        child.spawnSync=(command,args,options)=>{
            fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({command,args,cwd:options?.cwd??null})+'\\n');
            if(args[0]==='-p')return {status:0,stdout:JSON.stringify({version:process.versions.node,binary:process.execPath})};
            const output=args.find(value=>value.startsWith('--outputFile='));
            if(output)fs.writeFileSync(output.slice('--outputFile='.length),JSON.stringify({success:true,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,numTotalTests:1,numFailedTestSuites:0}));
            return {status:0,signal:null};
        };
        syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ['--import', preload, path.join(workspace, 'check.mjs'), ...args], {
        cwd: checkout, encoding: 'utf8', timeout: 5000,
        env: {NODE_BIN: process.execPath, NPM_CLI_JS: npm, PATH: path.dirname(process.execPath)},
    });
    assert.equal(result.error, undefined);
    const exists = async filename => fs.access(filename).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});
    const calls = await exists(callsFile) ? (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse) : [];
    const hasRun = await exists(path.join(checkout, '.run'));
    let report;
    if (hasRun) {
        const reports = await fs.readdir(path.join(checkout, '.run/check'));
        const filename = path.join(checkout, '.run/check', reports[0], 'report.json');
        if (await exists(filename)) report = JSON.parse(await fs.readFile(filename, 'utf8'));
    }
    return {...result, calls, hasRun, report, checkout};
}

for (const flag of ['--help', '-h']) test('check '+flag+' needs no manifests, runtime, npm or output directory', async t => {
    const value = await fixture(t, [flag], {withPackages: false});
    assert.equal(value.status, 0, value.stderr);
    assert.match(value.stdout, /--package/); assert.match(value.stdout, /--step/);
    assert.equal(value.hasRun, false); assert.deepEqual(value.calls, []);
});

for (const args of [['--unknown'], ['--package'], ['--step'], ['--package', 'services/catalog-service'],
    ['--package', '../frontend'], ['--package', 'unknown'], ['--step', 'contracts'], ['--step', 'unknown'],
    ['--help', '--package', 'frontend'], ['--package=frontend'], ['--package', 'frontend', '--step', 'test', '--unknown']]) {
    test('check rejects '+args.join(' ')+' before runtime resolution and filesystem outputs', async t => {
        const value = await fixture(t, args, {withPackages: false});
        assert.equal(value.status, 1); assert.match(value.stderr, /Неизвестный параметр|Некорректное значение/);
        assert.equal(value.hasRun, false); assert.deepEqual(value.calls, []);
    });
}

test('package and step selection execute only their intersection, without shared contracts or Compose', async t => {
    const value = await fixture(t, ['--package', 'frontend', '--step', 'test'], {packageFolders: ['frontend']});
    assert.equal(value.status, 0, value.stderr); assert.equal(value.report.success, true);
    assert.deepEqual(value.report.steps.map(step => step.name), ['frontend: test']);
    assert.deepEqual(value.report.selection, {packages: ['frontend'], steps: ['test']});
    const commands = value.calls.filter(call => call.args[0] !== '-p');
    assert.equal(commands.length, 1); assert.equal(commands[0].cwd, path.join(value.checkout, 'frontend'));
    assert.equal(commands[0].args[2], 'test'); assert.equal(commands[0].command, process.execPath);
    assert.deepEqual(value.report.steps[0].tests, {passed: 1, failed: 0, skipped: 0, todo: 0});
});

test('all eight canonical package IDs select their own builds and duplicate selectors run once', async t => {
    for (const folder of workspacePackages) {
        const id = packageId(folder), value = await fixture(t, ['--package', id, '--package', id, '--step', 'build', '--step', 'build']);
        assert.equal(value.status, 0, value.stderr);
        assert.deepEqual(value.report.steps.map(step => step.name), [folder+': build']);
        assert.equal(value.calls.filter(call => call.args[0] !== '-p').length, 1);
    }
});

test('step-only selection covers the eight packages without contracts or Compose', async t => {
    const value = await fixture(t, ['--step', 'typecheck']);
    assert.equal(value.status, 0, value.stderr);
    assert.deepEqual(value.report.steps.map(step => step.name), workspacePackages.map(folder => folder+': typecheck'));
    assert.equal(value.calls.filter(call => call.args[0] !== '-p').length, 8);
});

test('package-only selection retains normal phase order and excludes every other package', async t => {
    const value = await fixture(t, ['--package', 'frontend']);
    assert.equal(value.status, 0, value.stderr);
    assert.deepEqual(value.report.steps.map(step => step.name), ['frontend: typecheck', 'frontend: build', 'frontend: test']);
});

test('multiple package and step selectors retain workspace phase order without implicit builds', async t => {
    const value = await fixture(t, ['--package', 'bridge', '--package', 'frontend', '--step', 'test', '--step', 'typecheck']);
    assert.equal(value.status, 0, value.stderr);
    assert.deepEqual(value.report.steps.map(step => step.name), ['frontend: typecheck', 'mcp/neurocenter-asset-sync: typecheck',
        'frontend: test', 'mcp/neurocenter-asset-sync: test']);
    assert.equal(value.calls.filter(call => call.args[0] !== '-p').length, 4);
});

test('an empty selected test plan fails before runtime and outputs', async t => {
    const value = await fixture(t, ['--package', 'api-gateway', '--step', 'test']);
    assert.equal(value.status, 1); assert.match(value.stderr, /.+/);
    assert.equal(value.hasRun, false); assert.deepEqual(value.calls, []);
});

test('no selectors preserves all package phases followed by shared contracts and both Compose checks', async t => {
    const value = await fixture(t, []);
    assert.equal(value.status, 0, value.stderr); assert.equal(value.report.success, true);
    assert.deepEqual(value.report.steps.slice(0, 8).map(step => step.name), workspacePackages.map(folder => folder+': typecheck'));
    assert.deepEqual(value.report.steps.slice(8, 16).map(step => step.name), workspacePackages.map(folder => folder+': build'));
    assert.deepEqual(value.report.steps.slice(-3).map(step => step.name), ['Общие контракты, production и упаковка', 'Compose: dev', 'Compose: локальные эмбеддинги']);
});
