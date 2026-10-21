import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {workspacePackages} from '../workspace/check-plan.mjs';
import {readVitestReport} from '../workspace/check-report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const valid = {success: true, numPassedTests: 2, numFailedTests: 0, numPendingTests: 1,
    numTodoTests: 0, numTotalTests: 3, numFailedTestSuites: 0};

/** Настоящий CLI пишет отчёт в отдельном checkout; npm и Docker не выходят за fixture. */
async function fixture(t, {report = valid, raw, code = 0, signal, missing = false} = {}) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter check report ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const checkout = path.join(directory, 'checkout'), workspace = path.join(checkout, 'scripts/workspace');
    const bin = path.join(directory, 'bin'), calls = path.join(directory, 'calls.jsonl');
    await fs.mkdir(workspace, {recursive: true});
    await fs.mkdir(bin);
    for (const name of await fs.readdir(path.join(root, 'scripts/workspace'))) {
        if (/^check.*\.mjs$/.test(name) || name === 'node-runtime.mjs') {
            await fs.copyFile(path.join(root, 'scripts/workspace', name), path.join(workspace, name));
        }
    }
    for (const name of ['scripts/test', 'scripts/catalog-plugins/test', 'scripts/catalog-plugins/recipes/test']) {
        await fs.mkdir(path.join(checkout, name), {recursive: true});
    }
    for (const [index, name] of workspacePackages.entries()) {
        await fs.mkdir(path.join(checkout, name), {recursive: true});
        await fs.writeFile(path.join(checkout, name, 'package.json'), JSON.stringify({scripts: {
            typecheck: 'fixture', build: 'fixture', ...(index === 0 ? {test: 'vitest run'} : {}),
        }}));
    }
    const npm = path.join(directory, 'npm-cli.js');
    await fs.writeFile(npm, `const fs=require('node:fs'),args=process.argv.slice(2);
        fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
        if(args[1]==='test'){
            const output=args.find(value=>value.startsWith('--outputFile='))?.slice('--outputFile='.length);
            if(${!missing}&&output)fs.writeFileSync(output,${JSON.stringify(raw ?? JSON.stringify(report))});
            ${signal ? `process.kill(process.pid,${JSON.stringify(signal)});` : `process.exitCode=${code};`}
        }`);
    await fs.writeFile(path.join(bin, 'docker'), `#!${process.execPath}\nprocess.exitCode=0;\n`, {mode: 0o700});
    function run() {
        return spawnSync(process.execPath, [path.join(workspace, 'check.mjs')], {cwd: checkout, encoding: 'utf8', timeout: 20000,
            env: {NODE_BIN: process.execPath, NPM_CLI_JS: npm, PATH: [bin, path.dirname(process.execPath)].join(path.delimiter)}});
    }
    async function result() {
        const processResult = run();
        assert.equal(processResult.error, undefined);
        const directories = await fs.readdir(path.join(checkout, '.run/check'));
        assert.equal(directories.length, 1);
        const reportFile = path.join(checkout, '.run/check', directories[0], 'report.json');
        return {...processResult, report: JSON.parse(await fs.readFile(reportFile, 'utf8')),
            calls: (await fs.readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)};
    }
    return {result};
}

test('Успех check сохраняет раздельные passed/skipped и завершает все этапы', async t => {
    const actual = await (await fixture(t)).result();
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.report.success, true);
    assert.deepEqual(actual.report.steps.find(step => step.tests)?.tests, {passed: 2, failed: 0, skipped: 1, todo: 0});
    assert.equal(actual.report.steps.at(-1).name, 'Compose: локальные эмбеддинги');
});

for (const [description, options] of [
    ['отсутствующий JSON', {missing: true}],
    ['оборванный JSON', {raw: '{"success":'}],
    ['JSON null', {report: null}],
    ['JSON массив', {report: []}],
    ['пустой объект', {report: {}}],
    ['отрицательный счётчик', {report: {...valid, numPassedTests: -1}}],
    ['строковый счётчик', {report: {...valid, numPassedTests: '2'}}],
    ['неполный набор счётчиков', {report: {...valid, numTodoTests: undefined}}],
    ['несогласованную сумму', {report: {...valid, numTotalTests: 40}}],
    ['провал теста при exit 0', {report: {...valid, numPassedTests: 1, numFailedTests: 1}}],
    ['провал suite при exit 0', {report: {...valid, numFailedTestSuites: 1}}],
    ['success false при exit 0', {report: {...valid, success: false}}],
]) {
    test(`Check отклоняет ${description}, сохраняет причину и не продолжает план`, async t => {
        const actual = await (await fixture(t, options)).result();
        assert.equal(actual.status, 1, actual.stdout);
        assert.equal(actual.report.success, false);
        const last = actual.report.steps.at(-1);
        assert.equal(last.name, `${workspacePackages[0]}: test`);
        assert.equal(last.ok, false);
        assert.equal(last.exitCode, 0);
        assert.match(last.reportError, /.+/);
        assert.match(actual.stderr, /Проверка не прошла/);
        assert.match(actual.stderr, /Отчёт|отчёт/);
    });
}

test('Ошибка процесса остаётся ошибкой при успешном JSON', async t => {
    const actual = await (await fixture(t, {code: 7})).result();
    assert.equal(actual.status, 1);
    assert.equal(actual.report.success, false);
    assert.equal(actual.report.steps.at(-1).exitCode, 7);
    assert.equal(actual.report.steps.at(-1).ok, false);
});

test('TODO сохраняется отдельно от passed и skipped', async t => {
    const actual = await (await fixture(t, {report: {...valid, numTodoTests: 1, numTotalTests: 4}})).result();
    assert.equal(actual.status, 0, actual.stderr);
    assert.deepEqual(actual.report.steps.find(step => step.tests)?.tests, {passed: 2, failed: 0, skipped: 1, todo: 1});
});

test('Остановка процесса сигналом не теряет итоговую сводку', {skip: process.platform === 'win32'}, async t => {
    const actual = await (await fixture(t, {signal: 'SIGTERM', missing: true})).result();
    assert.equal(actual.status, 1);
    assert.equal(actual.report.success, false);
    assert.equal(actual.report.steps.at(-1).signal, 'SIGTERM');
    assert.equal(actual.report.steps.at(-1).ok, false);
});

test('Сводка совместима с настоящим Vitest: passed, skip и todo не смешиваются', async t => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter real vitest report ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const vitest = path.join(root, 'frontend/node_modules/vitest');
    await fs.writeFile(path.join(directory, 'fixture.test.mjs'), `
        import {test, expect} from ${JSON.stringify(pathToFileURL(path.join(vitest, 'dist/index.js')).href)};
        test('passed',()=>expect(2+2).toBe(4));
        test.skip('skipped',()=>{});
        test.todo('todo');
    `);
    const filename = path.join(directory, 'results.json');
    const result = spawnSync(process.execPath, [path.join(vitest, 'vitest.mjs'), 'run', '--root', directory,
        '--reporter=json', '--outputFile=' + filename], {cwd: directory, encoding: 'utf8', timeout: 20000});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readVitestReport(filename), {ok: true, tests: {passed: 1, failed: 0, skipped: 1, todo: 1}});
});
