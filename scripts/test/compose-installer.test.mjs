import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,symlink,readlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ensureCompose,composeAsset,composeVersion,checkCompose} from '../workspace/compose.mjs';

const version = '2.40.3';
const configBytes = Buffer.from('{\n\t"credsStore": "fixture-helper",\n  "cliPluginsExtraDirs": ["/fixture/extra"]\n}\n');

/** Исполняемый Compose fixture запускается абсолютным Node, не ищет программы в PATH. */
function plugin(release = version, wait = true) {
    return Buffer.from(`#!${process.execPath}\n`
        + `const args = process.argv.slice(2);\n`
        + `if (args.join(' ') === 'version --short') console.log(${JSON.stringify(release)});\n`
        + `else if (args.join(' ') === 'up --help') console.log(${JSON.stringify(wait ? '--wait --wait-timeout' : 'legacy help')});\n`
        + `else process.exitCode = 1;\n`);
}

const dockerFixture = `#!${process.execPath}
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const args = process.argv.slice(2), env = process.env;
if (args[0] === '--version') {
    console.log('Docker fixture CLI'); process.exit(env.FIXTURE_CLI_FAIL === '1' ? 1 : 0);
}
if (args[0] === 'info') {
    if(env.FIXTURE_ENGINE_HANG==='1'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);await new Promise(()=>{});}else process.exit(env.FIXTURE_ENGINE_FAIL === '1' ? 1 : 0);
}
if (args[0] !== 'compose') process.exit(1);
const target = path.join(env.DOCKER_CONFIG, 'cli-plugins/docker-compose');
if (existsSync(target) && env.FIXTURE_IGNORE_PLUGIN !== '1') {
    const result = spawnSync(target, args.slice(1), {env, encoding: 'utf8'});
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
}
if (!env.FIXTURE_COMPOSE_VERSION) process.exit(1);
if (args.slice(1).join(' ') === 'version --short') console.log(env.FIXTURE_COMPOSE_VERSION);
else if (args.slice(1).join(' ') === 'up --help') console.log(env.FIXTURE_WAIT === '0' ? 'legacy help' : '--wait --wait-timeout');
else process.exit(1);
`;

/** Весь Docker-каталог и единственный docker в PATH принадлежат одному тесту. */
async function fixture(action) {
    const root = await mkdtemp(path.join(tmpdir(), 'nc-compose-installer-'));
    const bin = path.join(root, 'bin'), config = path.join(root, 'docker');
    await mkdir(bin); await mkdir(config);
    await writeFile(path.join(bin, 'docker'), dockerFixture, {mode: 0o755});
    await writeFile(path.join(config, 'config.json'), configBytes);
    const env = {...process.env, PATH: bin, DOCKER_CONFIG: config};
    for (const key of Object.keys(env)) if (key.startsWith('FIXTURE_')) delete env[key];
    const bytes = plugin(), asset = {filename: 'docker-compose-fixture', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.invalid/compose-fixture'};
    const lock = {version, assets: Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(key => [key, asset]))};
    const target = path.join(config, 'cli-plugins/docker-compose');
    let downloads = 0;
    const fetchImpl = async url => {assert.equal(url, asset.url); downloads++; return new Response(bytes);};
    const install = changed => ensureCompose({env, platform: 'darwin', arch: 'arm64', fetchImpl, lock, ...changed});
    const old = async (release = '1.29.2', wait = false) => {
        const previous = plugin(release, wait);
        await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, previous, {mode: 0o755});
        return previous;
    };
    try {
        await action({env, bytes, asset, lock, target, install, old, downloads: () => downloads});
        assert.deepEqual(await readFile(path.join(config, 'config.json')), configBytes, 'config.json должен сохраниться побайтно');
    } finally {await rm(root, {recursive: true, force: true});}
}

test('Закреплённые assets выбираются для четырёх целей, неподдерживаемая архитектура отклоняется', async () => {
    await fixture(async ({lock,asset,install}) => {
        for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) assert.equal(composeAsset(platform, arch, lock), asset);
        assert.throws(() => composeAsset('linux', 'ia32', lock), /macOS\/Linux/);
        await assert.rejects(install({platform: 'linux', arch: 'ia32'}), /macOS\/Linux/);
    });
});

test('Современный Compose 5 сохраняется без загрузки и переписывания плагина', async () => {
    await fixture(async ({env,target,install,old,downloads}) => {
        const previous = await old('5.6.0', true);
        assert.equal(composeVersion(env), '5.6.0');
        assert.deepEqual(await install(), {installed: false, version: '5.6.0'});
        assert.equal(downloads(), 0); assert.deepEqual(await readFile(target), previous);
    });
});

test('Отсутствующий Compose устанавливается один раз без работающего daemon', async () => {
    await fixture(async ({env,bytes,target,install,downloads}) => {
        env.FIXTURE_ENGINE_FAIL = '1';
        assert.equal(composeVersion(env), null);
        assert.deepEqual(await install(), {installed: true, version, target});
        assert.deepEqual(await readFile(target), bytes);
        assert.deepEqual(await install(), {installed: false, version});
        assert.equal(downloads(), 1);
        assert.deepEqual(await readdir(path.dirname(target)), ['docker-compose']);
        assert.throws(() => checkCompose(env), /Docker Engine недоступен/);
    });
});

test('Старый Compose v1 и v2 без --wait обновляются с сохранением config.json', async () => {
    for (const release of ['1.29.2', '2.10.0']) await fixture(async ({env,bytes,target,install,old,downloads}) => {
        await old(release, false); assert.equal(composeVersion(env), null);
        assert.deepEqual(await install(), {installed: true, version, target});
        assert.deepEqual(await install(), {installed: false, version});
        assert.deepEqual(await readFile(target), bytes); assert.equal(downloads(), 1);
        assert.deepEqual(await readdir(path.dirname(target)), ['docker-compose']);
    });
});

test('Отказ SHA, размера или HTTP сохраняет прежний бинарник и удаляет временные файлы', async () => {
    for (const failure of ['sha', 'size', 'http']) await fixture(async ({bytes,target,install,old}) => {
        const previous = await old();
        const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
        const fetchImpl = async () => failure === 'http' ? new Response('fixture refusal', {status: 503})
            : new Response(failure === 'size' ? Buffer.concat([bytes, Buffer.from('x')]) : changed);
        await assert.rejects(install({fetchImpl}), failure === 'http' ? /HTTP 503/ : /SHA-256|Размер/);
        assert.deepEqual(await readFile(target), previous);
        assert.deepEqual(await readdir(path.dirname(target)), ['docker-compose']);
    });
});

test('Если Docker CLI не видит новый плагин, установка возвращает прежний комплект', async () => {
    for (const existing of [false, true]) await fixture(async ({env,target,install,old}) => {
        const previous = existing ? await old() : null;
        env.FIXTURE_IGNORE_PLUGIN = '1';
        await assert.rejects(install(), /Docker CLI не видит установленный Compose/);
        if (existing) assert.deepEqual(await readFile(target), previous);
        else await assert.rejects(access(target), {code: 'ENOENT'});
        assert.deepEqual(await readdir(path.dirname(target)), existing ? ['docker-compose'] : []);
    });
});

test('Откат сохраняет буквальную цель абсолютной, относительной и битой ссылки', async () => {
    for (const type of ['absolute', 'relative', 'broken']) await fixture(async ({env,target,install}) => {
        const destination = path.join(path.dirname(path.dirname(target)), type === 'broken' ? 'missing-compose' : 'previous-compose');
        const literal = type === 'absolute' ? destination : `../${path.basename(destination)}`;
        const previous = plugin('1.29.2', false);
        await mkdir(path.dirname(target), {recursive: true});
        if (type !== 'broken') await writeFile(destination, previous, {mode: 0o755});
        await symlink(literal, target);
        env.FIXTURE_IGNORE_PLUGIN = '1';
        await assert.rejects(install(), /Docker CLI не видит установленный Compose/);
        assert.equal((await lstat(target)).isSymbolicLink(), true);
        assert.equal(await readlink(target), literal);
        if (type === 'broken') await assert.rejects(access(destination), {code: 'ENOENT'});
        else assert.deepEqual(await readFile(destination), previous);
        assert.deepEqual(await readdir(path.dirname(target)), ['docker-compose']);
    });
});

test('Успешная установка заменяет битую ссылку и не создаёт её прежнюю цель', async () => {
    await fixture(async ({bytes,target,install}) => {
        const missing = path.join(path.dirname(path.dirname(target)), 'missing-compose');
        await mkdir(path.dirname(target), {recursive: true}); await symlink('../missing-compose', target);
        assert.deepEqual(await install(), {installed: true, version, target});
        assert.equal((await lstat(target)).isFile(), true);
        assert.deepEqual(await readFile(target), bytes);
        await assert.rejects(access(missing), {code: 'ENOENT'});
        assert.deepEqual(await readdir(path.dirname(target)), ['docker-compose']);
    });
});

test('Параллельная установка отклоняется до загрузки, блокировка затем освобождается', {timeout: 10000}, async () => {
    await fixture(async ({bytes,target,install}) => {
        let entered, release;
        const started = new Promise(resolve => {entered = resolve;});
        const gate = new Promise(resolve => {release = resolve;});
        let downloads = 0;
        const first = install({fetchImpl: async () => {downloads++; entered(); await gate; return new Response(bytes);}});
        try {
            await Promise.race([started, first.then(() => {throw new Error('Первая установка завершилась до загрузки');})]);
            await assert.rejects(install({fetchImpl: async () => {throw new Error('Второй install не должен загружать файл');}}), /Установка Compose уже выполняется/);
        } finally {release();}
        assert.deepEqual(await first, {installed: true, version, target});
        assert.equal(downloads, 1);
        assert.deepEqual(await readdir(path.dirname(target)), ['docker-compose']);
        assert.deepEqual(await install(), {installed: false, version});
    });
});

test('Проверка готовности различает отсутствующий CLI, Compose и daemon', async () => {
    await fixture(async ({env,old}) => {
        env.FIXTURE_CLI_FAIL = '1'; assert.throws(() => checkCompose(env), /Не найден Docker CLI/);
        delete env.FIXTURE_CLI_FAIL; assert.throws(() => checkCompose(env), /Нужен Compose v2/);
        await old(version, true); assert.doesNotThrow(() => checkCompose(env));
        env.FIXTURE_ENGINE_FAIL = '1'; assert.throws(() => checkCompose(env), /Docker Engine недоступен/);
    });
});

 test('An unresponsive Docker daemon cannot block startup after the bounded probe', {timeout:25000}, async()=>{
    await fixture(async({env,old})=>{
        await old(version,true);env.FIXTURE_ENGINE_HANG='1';const started=Date.now();
        assert.throws(()=>checkCompose(env),/Docker Engine недоступен/);
        assert.ok(Date.now()-started>=9500,'the daemon fixture must remain blocked until timeout');
        assert.ok(Date.now()-started<20000,'SIGKILL must bound a TERM-ignoring Docker CLI');
    });
});
