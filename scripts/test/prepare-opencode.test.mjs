import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const version = '1.14.48';
const registry = 'https://opencode-registry.invalid';
const variants = [
    'darwin-arm64', 'darwin-x64', 'darwin-x64-baseline',
    'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-baseline',
    'linux-x64-musl', 'linux-x64-baseline-musl',
    'windows-arm64', 'windows-x64', 'windows-x64-baseline',
];
const roots = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** Копирует установщик в отдельное дерево; все сетевые ответы принадлежат тесту. */
async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'neurocenter-prepare-opencode-'));
    roots.push(root);
    await mkdir(path.join(root, 'scripts'));
    for (const file of ['prepare-opencode.mjs', 'opencode-platforms.mjs']) {
        await copyFile(path.join(repository, 'scripts', file), path.join(root, 'scripts', file));
    }
    const responses = {};
    for (const variant of variants) {
        const name = `opencode-${variant}`;
        const body = `isolated fixture for ${name}@${version}\n`;
        const tarball = `${registry}/archives/${name}-${version}.tgz`;
        const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
        responses[`${registry}/${name}/${version}`] = {
            body: JSON.stringify({ name, version, dist: { tarball, integrity } }),
        };
        responses[tarball] = { body };
    }
    const fixtureFile = path.join(root, 'responses.json');
    const requestsFile = path.join(root, 'requests.log');
    const hook = path.join(root, 'fetch-fixture.mjs');
    await writeFile(hook, `
import { appendFileSync, readFileSync } from 'node:fs';
const responses = JSON.parse(readFileSync(process.env.TEST_RESPONSES, 'utf8'));
globalThis.fetch = async input => {
    const url = String(input);
    appendFileSync(process.env.TEST_REQUESTS, url + '\\n');
    if (process.env.TEST_OFFLINE === '1') throw new Error('Сетевой запрос при повторной подготовке');
    const response = responses[url];
    if (!response) throw new Error('Непредусмотренный запрос: ' + url);
    return new Response(response.body, { status: response.status ?? 200 });
};
`);
    const env = { ...process.env, OPENCODE_REGISTRY: registry, TEST_RESPONSES: fixtureFile, TEST_REQUESTS: requestsFile };
    delete env.OPENCODE_VERSION;
    delete env.OPENCODE_TARGETS;
    delete env.TEST_OFFLINE;
    const run = async (overrides = {}) => {
        await writeFile(fixtureFile, JSON.stringify(responses));
        return spawnSync(process.execPath, ['--import', hook, path.join(root, 'scripts/prepare-opencode.mjs')], {
            cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30_000,
        });
    };
    const requests = async () => {
        try { return (await readFile(requestsFile, 'utf8')).trim().split('\n').filter(Boolean); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    };
    return { root, directory: path.join(root, 'bridge-dist/opencode'), responses, requestsFile, requests, run };
}

test('Подготовка сохраняет все двенадцать официальных вариантов и их SHA-256', async () => {
    const f = await fixture();
    const result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    const archives = variants.map(variant => `opencode-${variant}-${version}.tgz`);
    assert.deepEqual((await readdir(f.directory)).sort(), archives.flatMap(file => [file, `${file}.sha256`]).sort());
    for (const file of archives) {
        const bytes = await readFile(path.join(f.directory, file));
        assert.equal(bytes.toString(), f.responses[`${registry}/archives/${file}`].body);
        assert.equal((await readFile(path.join(f.directory, `${file}.sha256`), 'utf8')).trim(), sha256(bytes));
    }
    const requests = await f.requests();
    assert.equal(requests.length, 24);
    assert.deepEqual(requests.sort(), Object.keys(f.responses).sort());
});

test('Повторная подготовка полного набора работает без сетевых запросов', async () => {
    const f = await fixture();
    const first = await f.run();
    assert.equal(first.status, 0, first.stderr);
    await rm(f.requestsFile);
    const repeated = await f.run({ TEST_OFFLINE: '1' });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(await f.requests(), []);
    assert.equal((await readdir(f.directory)).length, 24);
});

test('Подготовка выбранной платформы не скачивает остальные варианты', async () => {
    const f = await fixture();
    const result = await f.run({ OPENCODE_TARGETS: 'linux-x64-baseline' });
    assert.equal(result.status, 0, result.stderr);
    const file = `opencode-linux-x64-baseline-${version}.tgz`;
    assert.deepEqual((await readdir(f.directory)).sort(), [file, file + '.sha256'].sort());
    assert.equal((await f.requests()).length, 2);
});

test('Неизвестная платформа подготовки отклоняется до сетевых запросов', async () => {
    const f = await fixture();
    const result = await f.run({ OPENCODE_TARGETS: 'linux-unknown' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OPENCODE_TARGETS/);
    assert.deepEqual(await f.requests(), []);
});

test('Неверная контрольная сумма загрузки сохраняет прежний архив и не оставляет временных файлов', async () => {
    const f = await fixture();
    await mkdir(f.directory, { recursive: true });
    const archive = `opencode-darwin-arm64-${version}.tgz`;
    const previous = 'previous archive';
    const previousChecksum = '0'.repeat(64) + '\n';
    await writeFile(path.join(f.directory, archive), previous);
    await writeFile(path.join(f.directory, `${archive}.sha256`), previousChecksum);
    const url = `${registry}/opencode-darwin-arm64/${version}`;
    const metadata = JSON.parse(f.responses[url].body);
    metadata.dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    f.responses[url].body = JSON.stringify(metadata);
    const result = await f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Не совпала контрольная сумма opencode-darwin-arm64/);
    assert.equal(await readFile(path.join(f.directory, archive), 'utf8'), previous);
    assert.equal(await readFile(path.join(f.directory, `${archive}.sha256`), 'utf8'), previousChecksum);
    assert.ok((await readdir(f.directory)).every(file => !file.endsWith('.tmp')));
});
