import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { catalogReleaseManifest, catalogSyncEnvironment, parseSyncArguments, syncCatalog } from '../catalog-plugins/sync.mjs';
import { bundledCatalogManifest, parseCatalogSyncArguments, runCatalogSync, syncProductionCatalog } from '../production/sync-catalog.mjs';
import { maintenanceLock } from '../production/compose-client.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('Локальный CLI принимает только явную проверку и сохраняет настройки процесса', async () => {
    assert.deepEqual(parseSyncArguments([]), { dryRun: false });
    assert.deepEqual(parseSyncArguments(['--dry-run']), { dryRun: true });
    for (const args of [['--manifest', 'other.json'], ['--dry-run', '--dry-run'], ['--url']]) { assert.throws(() => parseSyncArguments(args)); }
    const env = await catalogSyncEnvironment({ CATALOG_PG_URL: 'postgresql://example.invalid/catalog', RUNTIME_ARTIFACT_DIR: 'test-runtime' });
    assert.equal(env.CATALOG_PG_URL, 'postgresql://example.invalid/catalog');
    assert.equal(env.RUNTIME_ARTIFACT_DIR, path.join(root, 'test-runtime'));
});

test('Синхронизация использует свежий CLI и один выбранный Node с тем же окружением', async () => {
    const calls = [], env = { PATH: '/fixture/bin', NODE_BIN: '/fixture/node24' };
    await syncCatalog({ dryRun: true }, {
        environment: async () => ({ source: 'private' }),
        runtime: source => { assert.deepEqual(source, { source: 'private' }); return { node: env.NODE_BIN, env }; },
        npm: source => { assert.equal(source, env); return '/fixture/npm-cli.js'; },
        run: async (...args) => { calls.push(args); },
    });
    assert.deepEqual(calls.map(item => item[1]), [
        ['/fixture/npm-cli.js', 'run', 'build'],
        [path.join(root, 'services/catalog-service/dist/builtin-catalog/sync.cli.js'), catalogReleaseManifest, '--dry-run'],
    ]);
    assert.ok(calls.every(([node, , options]) => node === env.NODE_BIN && options.env === env
        && options.cwd === path.join(root, 'services/catalog-service')));
});

test('Серверный режим передаёт выбранный стек без чтения локальной БД и сборки на хосте', async () => {
    const options = parseSyncArguments(['--production', '--directory', '/private/config', '--project-name', 'server', '--dry-run']);
    assert.deepEqual(options, { production: true, directory: '/private/config', projectName: 'server', dryRun: true });
    const env = { PATH: '/fixture/bin' }, calls = [];
    await syncCatalog(options, {
        environment: async () => { throw new Error('Локальное окружение не требуется'); },
        npm: () => { throw new Error('Сборка на хосте не требуется'); },
        runtime: source => { assert.equal(source, process.env); return { node: '/fixture/node24', env }; },
        run: async (...args) => { calls.push(args); },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/fixture/node24');
    assert.deepEqual(calls[0][1], [path.join(root, 'scripts/production/sync-catalog.mjs'),
        '--directory', '/private/config', '--project-name', 'server', '--dry-run']);
    assert.equal(calls[0][2].cwd, root);
    assert.equal(calls[0][2].env, env);
    assert.deepEqual(parseSyncArguments(['--production']), { production: true, ...parseCatalogSyncArguments([]) });
    for (const args of [['--directory', '/private/config'], ['--production', '--production'],
        ['--production', '--directory'], ['--production', '--dry-run', '--dry-run'],
        ['--production', '--project-name', 'first', '--project-name', 'second'], ['--production', '--url']]) {
        assert.throws(() => parseSyncArguments(args));
    }
});

test('Ошибка сборки не запускает старую скомпилированную синхронизацию', async () => {
    let calls = 0;
    await assert.rejects(syncCatalog({ dryRun: false }, {
        environment: async () => ({}), runtime: () => ({ node: '/fixture/node', env: {} }), npm: () => '/fixture/npm.js',
        run: async () => { calls++; throw new Error('ошибка сборки'); },
    }), /ошибка сборки/);
    assert.equal(calls, 1);
});

test('Production-команда закрепляет стек и манифест образа без запуска зависимостей', async () => {
    const calls = [];
    const result = await runCatalogSync({ run: async (...args) => {
        calls.push(args); return JSON.stringify({ ok: true, dryRun: false, downloadOnly: true, artifacts: 3 });
    } }, { downloadOnly: true, timeout: 1234 }, { uuid: () => 'fixture' });
    assert.equal(result.artifacts, 3);
    assert.deepEqual(calls, [[['run', '--rm', '--no-deps', '-T', '--pull', 'never', '--name', 'neurocenter-catalog-sync-fixture',
        '--label', 'neurocenter.catalog-sync=fixture', 'catalog-service',
        'node', 'dist/builtin-catalog/sync.cli.js', bundledCatalogManifest, '--download-only'], { timeout: 1234 }]]);
});

test('Production-wrapper держит общую блокировку и передаёт проверку без вложенной блокировки', async () => {
    const events = [], options = parseCatalogSyncArguments(['--directory', '/fixture/config', '--project-name', 'fixture', '--dry-run']);
    const client = { projectName: 'fixture', run: async command => {
        events.push(command); return JSON.stringify({ ok: true, dryRun: true, tools: [] });
    } };
    await syncProductionCatalog(options, {
        composeClient: input => { assert.deepEqual(input, { directory: '/fixture/config', projectName: 'fixture' }); return client; },
        composeConfiguration: async () => ({ services: { 'catalog-service': { image: 'sha256:fixture' } } }),
        maintenanceLock: async (input, image, operation, action) => {
            assert.equal(input, client); assert.equal(image, 'sha256:fixture'); assert.equal(operation, 'catalog-sync');
            events.push('lock'); try { return await action(); } finally { events.push('unlock'); }
        },
    });
    assert.equal(events[0], 'lock'); assert.equal(events.at(-1), 'unlock');
    assert.ok(events[1].includes('--dry-run'));
    assert.throws(() => parseCatalogSyncArguments(['--project-name', 'fixture', '--project-name', 'other']));
});

test('Ошибочный результат синхронизации не считается готовым каталогом', async () => {
    for (const output of ['', '{"ok":false,"dryRun":false,"tools":[]}', '{"ok":true,"dryRun":true,"tools":[]}']) {
        await assert.rejects(runCatalogSync({ run: async () => output }, {}, { docker: async () => '' }));
    }
});

test('Таймаут дожидается удаления только собственного контейнера до возврата ошибки', async () => {
    const id = 'a'.repeat(64), events = [];
    let present = true;
    await assert.rejects(runCatalogSync({ run: async () => { events.push('timeout'); throw new Error('таймаут'); } },
        { timeout: 1 }, { uuid: () => 'fixture', docker: async command => {
            events.push(command);
            if (command[0] === 'ps') {
                assert.ok(command.includes('name=^/neurocenter-catalog-sync-fixture$'));
                assert.ok(command.includes('label=neurocenter.catalog-sync=fixture'));
                return present ? id : '';
            }
            assert.deepEqual(command, ['rm', '--force', id]);
            await new Promise(resolve => setTimeout(resolve, 10));
            present = false; events.push('removed'); return '';
        } }), /таймаут/);
    assert.equal(present, false); assert.ok(events.includes('removed'));
    assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'rm').length, 1);
    assert.equal(events.at(-1)[0], 'ps');
});

test('Неподтверждённая остановка сохраняет блокировку обслуживания', async () => {
    const id = 'b'.repeat(64), lockCalls = [];
    const action = () => runCatalogSync({ run: async () => { throw new Error('таймаут'); } }, {}, {
        docker: async command => { if (command[0] === 'ps') { return id; } throw new Error('Docker недоступен'); },
    });
    await assert.rejects(maintenanceLock({ projectName: 'fixture' }, 'image', 'catalog-sync', action, async command => {
        lockCalls.push(command); return 'owned-lock';
    }), error => error.retainMaintenanceLock === true && error.message.includes('Блокировка обслуживания сохранена'));
    assert.equal(lockCalls.length, 1); assert.equal(lockCalls[0][0], 'create');
});

test('Обычная ошибка с завершённой очисткой освобождает собственную блокировку', async () => {
    const calls = [];
    await assert.rejects(maintenanceLock({ projectName: 'fixture' }, 'image', 'catalog-sync',
        async () => { throw new Error('проверка отклонена'); }, async command => { calls.push(command); return 'owned-lock'; }), /проверка отклонена/);
    assert.deepEqual(calls.at(-1), ['rm', 'owned-lock']);
});

/** Настоящий setup CLI работает в изолированном checkout, без Docker и сети. */
async function setupFixture(t, failSync = false, failModels = false) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-catalog-setup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const scripts = path.join(directory, 'scripts/production'), config = path.join(directory, 'config'), calls = path.join(directory, 'calls.jsonl');
    await mkdir(scripts, { recursive: true }); await mkdir(config);
    await writeFile(path.join(config, '.env'), "NEUROCENTER_RELEASE='fixture'\n");
    await writeFile(path.join(config, 'tls'), 'fixture');
    for (const file of ['setup.mjs', 'sync-catalog.mjs', 'sync-models.mjs', 'owned-sync-container.mjs']) { await copyFile(path.join(root, 'scripts/production', file), path.join(scripts, file)); }
    await writeFile(path.join(scripts, 'configuration.mjs'), 'export const ensureMetricsToken=async()=>{}; export const configureProduction=async()=>{};');
    await writeFile(path.join(scripts, 'compose-client.mjs'), `
        import fs from 'node:fs';
        export const repositoryRoot=${JSON.stringify(directory)};
        const record=value=>fs.appendFileSync(process.env.CATALOG_SETUP_CALLS,JSON.stringify(value)+'\\n');
        export const composeClient=()=>({run:async command=>{
            record(command);
            if(command.includes('dist/builtin-catalog/sync.cli.js')){
                if(process.env.CATALOG_SETUP_FAIL==='true')throw Error('fixture catalog failed');
                return JSON.stringify({ok:true,dryRun:false,tools:[]});
            }
            if(command.includes('/tools/scripts/models/bundle-cli.mjs')){
                if(process.env.MODEL_SETUP_FAIL==='true')throw Error('fixture models failed');
                return JSON.stringify({ok:true,downloadOnly:false,verifyOnly:false,models:2,files:9,bytes:4400000000});
            }
            return '';
        }});
        export const composeConfiguration=async()=>({services:{'catalog-service':{image:'fixture'}},
            secrets:{tls_cert:{file:${JSON.stringify(path.join(config, 'tls'))}},tls_key:{file:${JSON.stringify(path.join(config, 'tls'))}}}});
        export const maintenanceLock=async(client,image,mode,action)=>{
            record('lock');try{return await action();}finally{record('unlock');}
        };
        export const saveDiagnostic=async()=>{};
        export const docker=async()=>'';
    `);
    const result = spawnSync(process.execPath, [path.join(scripts, 'setup.mjs'), 'up', '--directory', config, '--project-name', 'fixture'],
        { encoding: 'utf8', env: { ...process.env, CATALOG_SETUP_CALLS: calls, CATALOG_SETUP_FAIL: String(failSync), MODEL_SETUP_FAIL: String(failModels) }, timeout: 10000 });
    assert.equal(result.error, undefined);
    const events = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    return { result, events };
}

test('Первый production-запуск готовит PostgreSQL и сборщик места до каталога и приложений', async t => {
    const { result, events } = await setupFixture(t);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events.slice(0, 4), ['lock', ['up', '-d', '--wait', 'postgres'],
        ['--profile', 'setup', 'run', '--rm', 'database-init'], ['up', '-d', '--wait', 'capacity-collector']]);
    assert.ok(events[4].includes('dist/builtin-catalog/sync.cli.js'));
    assert.ok(events[5].includes('/tools/scripts/models/bundle-cli.mjs'));
    assert.deepEqual(events.slice(6), [['up', '-d', '--wait'], 'unlock']);
});

test('Ошибка каталога при первом production-запуске не запускает приложения', async t => {
    const { result, events } = await setupFixture(t, true);
    assert.equal(result.status, 1); assert.match(result.stderr, /catalog failed/);
    assert.ok(!events.some(event => Array.isArray(event) && event.length === 3 && event[0] === 'up'));
    assert.equal(events.at(-1), 'unlock');
});

test('Ошибка комплекта моделей при первом production-запуске не выдаёт пустой runtime за готовый', async t => {
    const { result, events } = await setupFixture(t, false, true);
    assert.equal(result.status, 1); assert.match(result.stderr, /models failed/);
    assert.ok(!events.some(event => Array.isArray(event) && event.length === 3 && event[0] === 'up'));
    assert.equal(events.at(-1), 'unlock');
});
