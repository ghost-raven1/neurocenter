import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {nodeRuntime, npmCli} from '../workspace/node-runtime.mjs';
import {checkPlan, nodeTestFiles, workspacePackages} from '../workspace/check-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('npm и обычный node-потомок используют выбранный runtime, обходя старый node из PATH', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter runtime '));
    try {
        if (process.platform !== 'win32') await fs.writeFile(path.join(temporary, 'node'), '#!/bin/sh\nexit 82\n', {mode: 0o700});
        const selected = nodeRuntime({...process.env, NODE_BIN: process.execPath, PATH: temporary + path.delimiter + process.env.PATH});
        assert.ok(Number(selected.version.split('.')[0]) >= 24);
        const command = process.platform === 'win32' ? 'node.exe' : 'node';
        const child = spawnSync(command, ['-p', 'process.versions.node'], {env: selected.env, encoding: 'utf8'});
        assert.equal(child.status, 0); assert.equal(child.stdout.trim(), selected.version);
        const npm = spawnSync(selected.node, [npmCli(selected.env), '--version'], {env: selected.env, encoding: 'utf8'});
        assert.equal(npm.status, 0); assert.match(npm.stdout.trim(), /^\d+\.\d+\.\d+$/);
    } finally { await fs.rm(temporary, {recursive: true, force: true}); }
});

test('Явно заданный неработающий NODE_BIN не подменяется другим runtime', () => {
    assert.throws(() => nodeRuntime({...process.env, NODE_BIN: path.join(os.tmpdir(), 'missing-neurocenter-node')}), /NODE_BIN/);
});

test('Dev-команда соблюдает явный npm CLI и запускает его выбранным Node во всех пакетах', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter dev runtime '));
    try {
        const cli = path.join(temporary, 'npm-cli.js'), records = path.join(temporary, 'calls.jsonl');
        await fs.writeFile(cli, `require('node:fs').appendFileSync(${JSON.stringify(records)},JSON.stringify({node:process.versions.node,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');`);
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/dev.mjs'), 'install'], {
            cwd: root, env: {...process.env, NODE_BIN: process.execPath, NPM_CLI_JS: cli}, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.status, 0, result.stderr);
        const calls = (await fs.readFile(records, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
        assert.deepEqual(calls.map(call => path.relative(root, call.cwd)).sort(), [...workspacePackages].sort());
        for (const call of calls) {assert.ok(Number(call.node.split('.')[0]) >= 24); assert.deepEqual(call.args, ['ci', '--no-audit', '--no-fund']);}
    } finally {await fs.rm(temporary, {recursive: true, force: true});}
});

test('Общий check проверяет свежий dist, новые контракты и авторизацию, не запускает live-сценарии', () => {
    const files = nodeTestFiles(root), plan = checkPlan(root);
    for (const file of ['scripts/test/auth-security.mjs', 'scripts/test/blitz-flow.test.mjs', 'scripts/test/tool-runtime-source.test.mjs',
        'scripts/test/repository-source.test.mjs', 'scripts/catalog-plugins/test/runtime-source.test.mjs', 'scripts/test/workspace-check.test.mjs']) assert.ok(files.includes(file), file);
    assert.equal(files.length, new Set(files).size);
    assert.ok(!files.includes('scripts/test/qa-api.mjs')); assert.ok(!files.includes('scripts/test/production-stack.mjs'));
    for (const directory of workspacePackages) {
        const build = plan.findIndex(step => step.directory === directory && step.args.includes('build'));
        const typecheck = plan.findIndex(step => step.directory === directory && step.args.includes('typecheck'));
        assert.ok(typecheck >= 0 && build > typecheck);
    }
    const common = plan.findIndex(step => step.type === 'node');
    assert.ok(plan.slice(common + 1).every(step => step.type === 'compose'));
    assert.ok(plan.slice(0, common).some(step => step.directory === 'mcp/neurocenter-asset-sync' && step.args.includes('build')));
});
