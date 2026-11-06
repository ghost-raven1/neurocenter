import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertDistFresh, stampDigest, stampInputNames, writeStamp } from '../workspace/dist-freshness.mjs';
import { checkPlan } from '../workspace/check-plan.mjs';
import { buildPackages } from '../workspace/isolated-build-source.mjs';
import { BRIDGE_SHARED_RUNTIME_FILES } from '../../mcp/neurocenter-asset-sync/scripts/runtime-shared-files.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const workspace = fileURLToPath(new URL('../workspace/', import.meta.url));
const distPackages = buildPackages.filter(([id]) => id !== 'frontend');
const exists = async (file) =>
    fs.access(file).then(
        () => true,
        (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
        },
    );
const put = async (root, name, content) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
};
const stale = (error) => error.code === 'DIST_STALE' && /run nest build/.test(error.message);

/** Чекout с семью dist-пакетами: входы сборки, dist-entries и shared-файлы моста. */
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'nc dist freshness ')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const [id, directory, entry] of distPackages) {
        await put(root, `${directory}/src/app.ts`, `export const value = ${JSON.stringify(id)};\n`);
        await put(root, `${directory}/package.json`, JSON.stringify({ name: id, scripts: { test: 'vitest run' } }));
        await put(root, `${directory}/dist/${entry}`, `// ${id} dist\n`);
        if (directory === 'mcp/neurocenter-asset-sync') {
            await put(root, `${directory}/tsconfig.json`, '{}\n');
            await put(root, `${directory}/package-lock.json`, '{}\n');
            await put(root, `${directory}/vendor/ollama-runtime/package.json`, '{}\n');
            await put(root, `${directory}/vendor/ollama-runtime/index.js`, 'export {};\n');
            await fs.mkdir(path.join(root, directory, 'scripts'), { recursive: true });
            await fs.copyFile(
                path.join(repository, directory, 'scripts/runtime-shared-files.mjs'),
                path.join(root, directory, 'scripts/runtime-shared-files.mjs'),
            );
            for (const name of BRIDGE_SHARED_RUNTIME_FILES)
                await put(root, `services/shared/${name}`, `module.exports = {};\n`);
        } else {
            await put(root, `${directory}/tsconfig.json`, '{}\n');
            await put(root, `${directory}/tsconfig.build.json`, '{}\n');
            await put(root, `${directory}/nest-cli.json`, '{}\n');
        }
    }
    return root;
}

test('чистый checkout без stamp — явная «run nest build», а не фэйл теста', async (t) => {
    const root = await fixture(t);
    await assert.rejects(assertDistFresh(root, 'services/catalog-service'), stale);
    await assert.rejects(assertDistFresh(root, 'mcp/neurocenter-asset-sync'), stale);
});

test('stamp успешной сборки — только {schemaVersion, srcSha256} в .run, guard прозрачен', async (t) => {
    const root = await fixture(t);
    const sha = await writeStamp(root, 'services/catalog-service');
    assert.match(sha, /^[a-f0-9]{64}$/);
    const file = path.join(root, '.run/dist-stamps/services/catalog-service.json');
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).sort(), ['schemaVersion', 'srcSha256']);
    const stamp = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stamp.schemaVersion, 1);
    assert.equal(stamp.srcSha256, sha);
    assert.equal(await exists(path.join(root, 'services/catalog-service/dist-stamps')), false);
    await assertDistFresh(root, 'services/catalog-service');
});

test('изменение src/ после сборки — guard останавливает test-шаг (stale)', async (t) => {
    const root = await fixture(t);
    await writeStamp(root, 'services/catalog-service');
    await put(root, 'services/catalog-service/src/app.ts', 'export const value = "changed";\n');
    await assert.rejects(assertDistFresh(root, 'services/catalog-service'), stale);
});

test('изменение build-конфига тоже меняет closure (stale)', async (t) => {
    const root = await fixture(t);
    await writeStamp(root, 'services/feature-flags-service');
    await put(root, 'services/feature-flags-service/nest-cli.json', '{ "changed": true }\n');
    await assert.rejects(assertDistFresh(root, 'services/feature-flags-service'), stale);
    await writeStamp(root, 'services/feature-flags-service');
    await put(root, 'services/feature-flags-service/package.json', '{ "name": "feature-flags-service" }\n');
    await assert.rejects(assertDistFresh(root, 'services/feature-flags-service'), stale);
});

test('удалённый dist/entry при свежем src — явная «run nest build» (dist-gone)', async (t) => {
    const root = await fixture(t);
    await writeStamp(root, 'services/oauth2-bridge');
    await fs.rm(path.join(root, 'services/oauth2-bridge/dist'), { recursive: true });
    await assert.rejects(assertDistFresh(root, 'services/oauth2-bridge'), stale);
});

test('повторная сборка обновляет stamp и возвращает guard в зелёный (rebuild)', async (t) => {
    const root = await fixture(t);
    await writeStamp(root, 'services/rag-sync-service');
    await put(root, 'services/rag-sync-service/src/app.ts', 'export const value = "v2";\n');
    await assert.rejects(assertDistFresh(root, 'services/rag-sync-service'), stale);
    await writeStamp(root, 'services/rag-sync-service');
    await assertDistFresh(root, 'services/rag-sync-service');
});

test('closure моста включает vendor, lockfile и shared-файлы', async (t) => {
    const root = await fixture(t);
    const names = await stampInputNames(root, 'mcp/neurocenter-asset-sync');
    for (const expected of [
        'mcp/neurocenter-asset-sync/src/app.ts',
        'mcp/neurocenter-asset-sync/tsconfig.json',
        'mcp/neurocenter-asset-sync/package.json',
        'mcp/neurocenter-asset-sync/package-lock.json',
        'mcp/neurocenter-asset-sync/vendor/ollama-runtime/package.json',
        'mcp/neurocenter-asset-sync/vendor/ollama-runtime/index.js',
        ...BRIDGE_SHARED_RUNTIME_FILES.map((name) => `services/shared/${name}`),
    ])
        assert.ok(names.includes(expected), expected);
    const before = await stampDigest(root, 'mcp/neurocenter-asset-sync');
    await put(root, 'services/shared/runtime-artifacts.cjs', 'module.exports = { changed: true };\n');
    assert.notEqual(await stampDigest(root, 'mcp/neurocenter-asset-sync'), before);
    await writeStamp(root, 'mcp/neurocenter-asset-sync');
    await assertDistFresh(root, 'mcp/neurocenter-asset-sync');
});

test('CLI --write/--check делит механизм guard, устаревание — exit 1', async (t) => {
    const root = await fixture(t),
        cli = path.join(root, 'scripts/workspace/dist-freshness.mjs');
    await fs.mkdir(path.join(root, 'scripts/workspace'), { recursive: true });
    for (const name of ['dist-freshness.mjs', 'isolated-build-source.mjs'])
        await fs.copyFile(path.join(workspace, name), path.join(root, 'scripts/workspace', name));
    const run = (args) =>
        spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
    let result = run(['--check', 'services/catalog-service']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run nest build/);
    result = run(['--write', 'services/catalog-service']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^stamp services\/catalog-service: [a-f0-9]{64}$/);
    result = run(['--check', 'services/catalog-service']);
    assert.equal(result.status, 0, result.stderr);
    await put(root, 'services/catalog-service/src/app.ts', 'export const value = "changed";\n');
    result = run(['--check', 'services/catalog-service']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run nest build/);
    for (const args of [['--check'], ['--unknown', 'frontend'], ['--check', 'frontend'], ['--check', 'frontend', 'x']]) {
        result = run(args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Неизвестный dist-пакет|Использование/);
    }
});

test('checkPlan вешает distGuard на test-шаги dist-пакетов и общие контракты, но не на frontend и tooling', () => {
    const manifest = () => ({
        scripts: { lint: 'x', 'format:check': 'x', typecheck: 'x', build: 'x', test: 'vitest run' },
    }),
        inject = { readManifest: manifest, readTestFiles: () => [], readToolingFiles: () => [] };
    const full = checkPlan(repository, {}, inject);
    for (const [, directory] of distPackages) {
        const step = full.find((item) => item.directory === directory && item.name.endsWith(': test'));
        assert.ok(step, directory);
        assert.deepEqual(step.distGuard, [directory]);
    }
    for (const step of full)
        if (!step.name.endsWith(': test') && step.name !== 'Общие контракты, production и упаковка')
            assert.equal(step.distGuard, undefined, step.name);
    assert.equal(full.find((item) => item.directory === 'frontend').distGuard, undefined);
    assert.deepEqual(
        full.find((item) => item.name === 'Общие контракты, production и упаковка').distGuard,
        distPackages.map(([, directory]) => directory),
    );
    const scopedFrontend = checkPlan(repository, { packages: ['frontend'], steps: ['test'] }, inject);
    assert.equal(scopedFrontend[0].distGuard, undefined);
    const scopedBridge = checkPlan(repository, { packages: ['bridge'], steps: ['test'] }, inject);
    assert.deepEqual(scopedBridge[0].distGuard, ['mcp/neurocenter-asset-sync']);
    const scopedSteps = checkPlan(repository, { steps: ['lint'] }, inject);
    assert.ok(scopedSteps.every((step) => step.distGuard === undefined));
    const tooling = checkPlan(repository, { packages: [], steps: [], tooling: true }, inject);
    assert.ok(tooling.every((step) => step.distGuard === undefined));
});

/** runCheck: устаревший test-шаг останавливается до spawn'а, фёрный — проходит прозрачно. */
async function checkFixture(t) {
    const root = await fixture(t);
    const npm = path.join(root, 'npm-cli.js'),
        record = path.join(root, 'npm-calls.jsonl');
    await fs.writeFile(
        npm,
        `const fs=require('node:fs'),args=process.argv.slice(2);
        fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n');
        const output=args.find(value=>value.startsWith('--outputFile='));
        if(output)fs.writeFileSync(output.slice('--outputFile='.length),JSON.stringify({success:true,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,numTotalTests:1,numFailedTestSuites:0}));`,
    );
    const environment = {
        NODE_BIN: process.execPath,
        NPM_CLI_JS: npm,
        PATH: path.dirname(process.execPath),
    };
    const stderr = [];
    return {
        root,
        record,
        run: (options) =>
            import('../workspace/check.mjs').then(({ runCheck }) =>
                runCheck(root, options, { environment, output: { write: () => {} }, errorOutput: { write: (s) => stderr.push(s) } }),
            ),
        stderr: () => stderr.join(''),
    };
}

test('check останавливает устаревший test-шаг до раннера: DIST_STALE, тесты не выполнялись', async (t) => {
    const f = await checkFixture(t);
    await writeStamp(f.root, 'services/catalog-service');
    await put(f.root, 'services/catalog-service/src/app.ts', 'export const value = "changed";\n');
    const report = await f.run({ packages: ['catalog-service'], steps: ['test'] });
    assert.equal(report.success, false);
    assert.equal(report.state, 'failed');
    assert.deepEqual(report.failure, { code: 'DIST_STALE' });
    assert.equal(report.steps.length, 1);
    const step = report.steps[0];
    assert.equal(step.name, 'services/catalog-service: test');
    assert.equal(step.ok, false);
    assert.equal(step.exitCode, 1);
    assert.equal(step.signal, null);
    assert.equal(step.leaderReaped, false);
    assert.deepEqual(step.cleanup, { noLiveDescendants: true, signals: [], zombieCount: 0 });
    assert.deepEqual(step.failure, { code: 'DIST_STALE' });
    assert.equal('tests' in step, false);
    assert.equal('testRunner' in step, false);
    assert.equal('reportError' in step, false);
    assert.match(f.stderr(), /run nest build/);
    assert.equal(await exists(f.record), false);
});

test('check с актуальным dist проходит прозрачно, stamp не виден source-идентичности', async (t) => {
    const f = await checkFixture(t);
    await writeStamp(f.root, 'services/catalog-service');
    const report = await f.run({ packages: ['catalog-service'], steps: ['test'] });
    assert.equal(report.success, true, JSON.stringify(report.failure));
    const step = report.steps[0];
    assert.equal(step.ok, true);
    assert.equal(step.exitCode, 0);
    assert.equal(step.testRunner, 'vitest');
    assert.deepEqual(step.tests, { passed: 1, failed: 0, skipped: 0, todo: 0 });
    assert.equal((await fs.readFile(f.record, 'utf8')).trim().split('\n').length, 1);
});
