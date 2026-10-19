import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Изолированный checkout исполняет настоящий entrypoint без БД, Docker и сборочных зависимостей. */
async function fixture(t, envFile = 'CATALOG_PG_URL_FILE=secrets/catalog-url\n') {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'neurocenter sync entrypoint ')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const subdirectory of ['scripts/catalog-plugins', 'scripts/workspace', 'scripts/production', 'services/catalog-service/dist/builtin-catalog']) {
        await mkdir(path.join(directory, subdirectory), { recursive: true });
    }
    for (const file of ['catalog-plugins/sync.mjs', 'catalog-plugins/sync-environment.mjs', 'workspace/node-runtime.mjs',
        'production/sync-catalog.mjs', 'production/owned-sync-container.mjs', 'production/compose-client.mjs', 'production/configuration.mjs']) {
        await copyFile(path.join(root, 'scripts', file), path.join(directory, 'scripts', file));
    }
    await writeFile(path.join(directory, '.env'), envFile);
    const calls = path.join(directory, 'calls.jsonl'), npm = path.join(directory, 'npm-cli.js');
    const record = `const fs=require('node:fs');
        fs.appendFileSync(process.env.SYNC_ENTRYPOINT_CALLS,JSON.stringify({
            stage:STAGE,node:process.versions.node,args:process.argv.slice(2),
            url:process.env.CATALOG_PG_URL,file:process.env.CATALOG_PG_URL_FILE
        })+'\\n');`;
    await writeFile(npm, record.replace('STAGE', "'build'") + '\nprocess.exit(Number(process.env.SYNC_BUILD_EXIT||0));');
    await writeFile(path.join(directory, 'services/catalog-service/dist/builtin-catalog/sync.cli.js'),
        record.replace('STAGE', "'import'") + '\nconsole.log(JSON.stringify({ok:true}));process.exit(Number(process.env.SYNC_IMPORT_EXIT||0));');
    const legacy = path.join(directory, 'legacy-loader.mjs');
    await writeFile(legacy, `import util from 'node:util'; import {syncBuiltinESMExports} from 'node:module';
        util.parseEnv=undefined;syncBuiltinESMExports();
        Object.defineProperty(process,'execPath',{value:${JSON.stringify(path.join(directory, 'legacy-node'))}});`);
    const env = { ...process.env };
    for (const key of ['NODE_BIN', 'NODE_OPTIONS', 'CATALOG_PG_URL', 'CATALOG_PG_URL_FILE', 'NODE_ENV', 'RUNTIME_ARTIFACT_DIR']) { delete env[key]; }
    env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || '');
    env.NPM_CLI_JS = npm; env.SYNC_ENTRYPOINT_CALLS = calls;
    async function run({ handoff = false, args = ['--dry-run'], ...environment } = {}) {
        const result = spawnSync(process.execPath, [...(handoff ? ['--import', legacy] : []),
            path.join(directory, 'scripts/catalog-plugins/sync.mjs'), ...args],
        { cwd: directory, encoding: 'utf8', env: { ...env, ...environment }, timeout: 15000 });
        assert.equal(result.error, undefined);
        const events = await readFile(calls, 'utf8').catch(error => { if (error.code === 'ENOENT') { return ''; } throw error; });
        return { ...result, events: events.trim().split('\n').filter(Boolean).map(JSON.parse) };
    }
    return { directory, run };
}

test('Старый Node без parseEnv передаёт CLI в Node 24 до чтения .env и сохраняет файл подключения', async t => {
    const f = await fixture(t), result = await f.run({ handoff: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events.map(event => event.stage), ['build', 'import']);
    for (const event of result.events) {
        assert.ok(Number(event.node.split('.')[0]) >= 24);
        assert.equal(event.url, undefined);
        assert.equal(event.file, path.join(f.directory, 'secrets/catalog-url'));
    }
    assert.deepEqual(result.events[0].args, ['run', 'build']);
    assert.deepEqual(result.events[1].args, [path.join(f.directory, 'scripts/catalog-plugins/catalog-release.json'), '--dry-run']);
});

test('Передача запуска не перекрывает NODE_BIN, указанный в .env', async t => {
    const f = await fixture(t, 'NODE_BIN=/nonexistent/neurocenter-env-node\n'), result = await f.run({ handoff: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NODE_BIN должен указывать/);
    assert.deepEqual(result.events, []);
});

test('Ошибка сборки указывает этап и не запускает прежний dist', async t => {
    const f = await fixture(t), result = await f.run({ SYNC_BUILD_EXIT: '7' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Сборка catalog-service: команда завершилась с кодом 7/);
    assert.deepEqual(result.events.map(event => event.stage), ['build']);
});

test('Ошибка импорта различима с ошибкой сборки и сохраняет ненулевой результат', async t => {
    const f = await fixture(t), result = await f.run({ SYNC_IMPORT_EXIT: '9' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Импорт встроенного каталога: команда завершилась с кодом 9/);
    assert.deepEqual(result.events.map(event => event.stage), ['build', 'import']);
});

test('Настоящий production-entrypoint использует выбранный стек без host .env и npm-зависимостей', async t => {
    const f = await fixture(t, 'NODE_BIN=/nonexistent/host-node\nNODE_ENV=production\n');
    await writeFile(path.join(f.directory, 'scripts/production/compose-client.mjs'), `
        import fs from 'node:fs';
        export const repositoryRoot=${JSON.stringify(f.directory)};
        const record=value=>fs.appendFileSync(process.env.SYNC_ENTRYPOINT_CALLS,JSON.stringify(value)+'\\n');
        export const composeClient=options=>{
            record({stage:'config',...options});
            return {run:async command=>{
                record({stage:'container',command});return JSON.stringify({ok:true,dryRun:true,tools:[]});
            }};
        };
        export const composeConfiguration=async()=>({services:{'catalog-service':{image:'fixture'}}});
        export const maintenanceLock=async(client,image,mode,action)=>{
            record({stage:'lock',mode});try{return await action();}finally{record({stage:'unlock'});}
        };
        export const saveDiagnostic=async()=>{};
        export const docker=async()=>{throw Error('Реальный Docker не используется');};
    `);
    const config = path.join(f.directory, 'private config');
    const result = await f.run({ NODE_ENV: 'production', args: ['--production', '--directory', config, '--project-name', 'server', '--dry-run'] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, dryRun: true, tools: [] });
    assert.deepEqual(result.events.map(event => event.stage), ['config', 'lock', 'container', 'unlock']);
    assert.deepEqual(result.events[0], { stage: 'config', directory: config, projectName: 'server' });
    assert.equal(result.events[1].mode, 'catalog-sync');
    assert.ok(result.events[2].command.includes('/tools/scripts/catalog-plugins/catalog-release.json'));
    assert.equal(result.events[2].command.at(-1), '--dry-run');
});
