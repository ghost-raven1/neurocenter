import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nodeRuntime, npmCli} from './node-runtime.mjs';
import {checkPlan} from './check-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = nodeRuntime();
const npm = npmCli(runtime.env);
const directory = path.join(root, '.run/check', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(directory, {recursive: true, mode: 0o700});
const report = {startedAt: new Date().toISOString(), node: runtime.version, success: false, steps: []};
const steps = checkPlan(root);
for (const [index, step] of steps.entries()) {
    const filename = path.join(directory, `${String(index + 1).padStart(2, '0')}.log`);
    const log = fs.openSync(filename, 'wx', 0o600);
    console.log(`[${index + 1}/${steps.length}] ${step.name}`);
    const command = step.type === 'compose' ? 'docker' : runtime.node;
    const jsonFile = path.join(directory, `${String(index + 1).padStart(2, '0')}.json`);
    const args = step.type === 'npm' ? [npm, ...step.args, ...(step.vitest ? ['--', '--reporter=json', '--outputFile=' + jsonFile] : [])] : step.args;
    const started = Date.now();
    let result;
    try { result = spawnSync(command, args, {cwd: path.resolve(root, step.directory), env: runtime.env,
        stdio: ['ignore', log, log], timeout: 10 * 60 * 1000, killSignal: 'SIGKILL', windowsHide: true}); }
    finally { fs.closeSync(log); }
    const ok = result.status === 0;
    const entry = {name: step.name, ok, exitCode: result.status, signal: result.signal, durationMs: Date.now() - started,
        ...(result.error ? {errorCode: result.error.code} : {}), log: path.relative(root, filename)};
    if (step.vitest && fs.existsSync(jsonFile)) {
        const tests = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        entry.tests = {passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests};
        entry.results = path.relative(root, jsonFile);
    }
    report.steps.push(entry);
    report.finishedAt = new Date().toISOString();
    report.success = ok && report.steps.length === steps.length;
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    if (!ok) {
        console.error(`Проверка не прошла: ${step.name}. Лог: ${path.relative(root, filename)}`);
        process.exitCode = 1;
        break;
    }
}
console.log(`Отчёт: ${path.relative(root, path.join(directory, 'report.json'))}`);
