import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { catalogSyncEnvironment } from '../catalog-plugins/sync-environment.mjs';

/** Все env-файлы принадлежат тесту; рабочие настройки и файлы секретов не читаются. */
async function fixture(t, files = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-sync-env-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const [filename, contents] of Object.entries(files)) { await writeFile(path.join(directory, filename), contents); }
    return directory;
}

test('Окружение процесса приоритетнее .env.local, а локальный файл приоритетнее .env', async t => {
    const directory = await fixture(t, {
        '.env': 'CHOICE=base\nONLY_BASE=kept\nCATALOG_PG_URL=postgresql://base.invalid/catalog\n',
        '.env.local': 'CHOICE=local\nONLY_LOCAL=kept\nCATALOG_PG_URL=postgresql://local.invalid/catalog\n',
    });
    const local = await catalogSyncEnvironment({}, { directory });
    assert.equal(local.CHOICE, 'local');
    assert.equal(local.CATALOG_PG_URL, 'postgresql://local.invalid/catalog');
    const env = await catalogSyncEnvironment({ CHOICE: 'process', CATALOG_PG_URL: 'postgresql://process.invalid/catalog' }, { directory });
    assert.equal(env.CHOICE, 'process'); assert.equal(env.ONLY_BASE, 'kept'); assert.equal(env.ONLY_LOCAL, 'kept');
    assert.equal(env.CATALOG_PG_URL, 'postgresql://process.invalid/catalog');
});

test('Файл секрета процесса заменяет URL обоих env-файлов без dev-подключения', async t => {
    const directory = await fixture(t, {
        '.env': 'CATALOG_PG_URL=postgresql://base.invalid/catalog\n',
        '.env.local': 'CATALOG_PG_URL=postgresql://local.invalid/catalog\n',
    });
    const env = await catalogSyncEnvironment({ NODE_ENV: 'production', CATALOG_PG_URL_FILE: 'secrets/not-read' }, { directory });
    assert.equal(env.CATALOG_PG_URL, undefined);
    assert.equal(env.CATALOG_PG_URL_FILE, path.join(directory, 'secrets/not-read'));
});

test('Файл секрета из .env.local заменяет URL менее приоритетного файла', async t => {
    const directory = await fixture(t, {
        '.env': 'CATALOG_PG_URL=postgresql://base.invalid/catalog\n',
        '.env.local': 'CATALOG_PG_URL_FILE=secrets/catalog-url\n',
    });
    const env = await catalogSyncEnvironment({}, { directory });
    assert.equal(env.CATALOG_PG_URL, undefined);
    assert.equal(env.CATALOG_PG_URL_FILE, path.join(directory, 'secrets/catalog-url'));
});

test('URL и файл в одном слое сохраняются с приоритетом URL для CLI', async t => {
    const directory = await fixture(t);
    const env = await catalogSyncEnvironment({ CATALOG_PG_URL: 'postgresql://explicit.invalid/catalog', CATALOG_PG_URL_FILE: 'secret' }, { directory });
    assert.equal(env.CATALOG_PG_URL, 'postgresql://explicit.invalid/catalog');
    assert.equal(env.CATALOG_PG_URL_FILE, path.join(directory, 'secret'));
});

test('URL процесса заменяет файл секрета из env-файла', async t => {
    const directory = await fixture(t, { '.env': 'CATALOG_PG_URL_FILE=secrets/catalog-url\n' });
    const env = await catalogSyncEnvironment({ CATALOG_PG_URL: 'postgresql://explicit.invalid/catalog' }, { directory });
    assert.equal(env.CATALOG_PG_URL, 'postgresql://explicit.invalid/catalog');
    assert.equal(env.CATALOG_PG_URL_FILE, undefined);
});

test('Только отсутствие обоих источников подключения включает локальный dev-default', async t => {
    const directory = await fixture(t);
    const env = await catalogSyncEnvironment({}, { directory });
    assert.equal(env.CATALOG_PG_URL, 'postgresql://rag:rag@localhost:5432/catalog');
    assert.equal(env.RUNTIME_ARTIFACT_DIR, path.join(directory, 'data/runtime-artifacts'));
    const fileOnly = await catalogSyncEnvironment({ CATALOG_PG_URL: '', CATALOG_PG_URL_FILE: 'secret' }, { directory });
    assert.equal(fileOnly.CATALOG_PG_URL, undefined);
    assert.equal(fileOnly.CATALOG_PG_URL_FILE, path.join(directory, 'secret'));
});

test('Production без подключения завершается понятной ошибкой без dev-default', async t => {
    const directory = await fixture(t, { '.env': 'NODE_ENV=production\n' });
    await assert.rejects(catalogSyncEnvironment({}, { directory }), /production.*CATALOG_PG_URL.*CATALOG_PG_URL_FILE/);
});

test('Абсолютные пути сохраняются, относительные закрепляются от directory, исходное окружение неизменно', async t => {
    const directory = await fixture(t);
    const source = Object.freeze({ CATALOG_PG_URL_FILE: '../catalog-secret', RUNTIME_ARTIFACT_DIR: 'runtime', NODE_ENV: 'production' });
    const env = await catalogSyncEnvironment(source, { directory });
    assert.equal(env.CATALOG_PG_URL_FILE, path.resolve(directory, '../catalog-secret'));
    assert.equal(env.RUNTIME_ARTIFACT_DIR, path.join(directory, 'runtime'));
    assert.deepEqual(source, { CATALOG_PG_URL_FILE: '../catalog-secret', RUNTIME_ARTIFACT_DIR: 'runtime', NODE_ENV: 'production' });
    const absolute = await catalogSyncEnvironment({ CATALOG_PG_URL_FILE: path.join(directory, 'secret'), RUNTIME_ARTIFACT_DIR: path.join(directory, 'artifacts') }, { directory });
    assert.equal(absolute.CATALOG_PG_URL_FILE, path.join(directory, 'secret'));
    assert.equal(absolute.RUNTIME_ARTIFACT_DIR, path.join(directory, 'artifacts'));
});

test('Без parseEnv модуль импортируется, а прямой вызов просит Node 24', () => {
    const helper = new URL('../catalog-plugins/sync-environment.mjs', import.meta.url).href;
    const source = `import util from 'node:util'; import {syncBuiltinESMExports} from 'node:module';
        util.parseEnv=undefined; syncBuiltinESMExports();
        const {catalogSyncEnvironment}=await import(${JSON.stringify(helper)});
        try { await catalogSyncEnvironment({}); process.exitCode=1; }
        catch(error) { console.log(error.message); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node\.js 24/);
});
