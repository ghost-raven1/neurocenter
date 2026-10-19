import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,chmod,symlink,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {configuration} from '../embedding/config.mjs';
import {withControlLock} from '../embedding/runtime.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const configUrl = new URL('../embedding/config.mjs', import.meta.url).href;
const runtimeUrl = new URL('../embedding/runtime.mjs', import.meta.url).href;

/** Дочерний процесс не обращается к Docker daemon, сети или моделям. */
const runnerSource = `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const {configuration} = await import(process.argv[5]);
const config = configuration({}, process.argv[2], process.argv[3]);
const outside = process.argv[6] ? await fs.promises.realpath(process.argv[6]) : null;
let outsideReadAttempts = 0;
const originalReadFile = fs.promises.readFile;
const originalOpen = fs.promises.open;
async function rejectsOutside(filename) {
    if (!outside) return;
    let target;
    try {target = await fs.promises.realpath(filename);} catch {return;}
    if (target === outside) {
        outsideReadAttempts++;
        throw new Error('Перехвачена попытка чтения внешней квитанции.');
    }
}
fs.promises.readFile = async (filename, ...args) => {
    await rejectsOutside(filename);
    return originalReadFile(filename, ...args);
};
fs.promises.open = async (filename, flags, ...args) => {
    if (typeof flags !== 'number' || !(flags & fs.constants.O_NOFOLLOW)) await rejectsOutside(filename);
    return originalOpen(filename, flags, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async url => new Response(JSON.stringify(String(url).endsWith('/api/tags')
    ? {models: [{name: config.lock.model, digest: config.lock.manifestSha256}]}
    : {version: 'own-fixture'}));
try {
    const {status} = await import(process.argv[4]);
    const value = await status(config);
    console.log(JSON.stringify({value, outsideReadAttempts}));
} catch (error) {
    console.log(JSON.stringify({error: {message: error.message, code: error.code}, outsideReadAttempts}));
}
`;

/** Подготавливает отдельные данные и подставной Docker только для своего процесса. */
async function fixture(action) {
    const temporary = await mkdtemp(path.join(tmpdir(), 'nc-model-readiness-test-'));
    const root = path.join(temporary, 'workspace');
    const bin = path.join(temporary, 'bin');
    await mkdir(path.join(root, 'data/embedding'), {recursive: true});
    await mkdir(bin);
    const runner = path.join(temporary, 'status.mjs');
    await writeFile(runner, runnerSource);
    const docker = path.join(bin, 'docker');
    await writeFile(docker, '#!' + process.execPath + '\n'
        + 'console.log(process.argv[2] === "compose" ? "own-fixture" : process.env.REVIEW_CONTAINER_JSON);\n');
    await chmod(docker, 0o700);
    try {return await action({temporary,root,bin,runner});}
    finally {await rm(temporary, {recursive: true, force: true});}
}

function receipt(config) {
    return {model: config.lock.model, manifestSha256: config.lock.manifestSha256, image: config.lock.image,
        ...(config.capability === 'vision' ? {capability: 'vision', visionVerified: true} : {dimension: config.lock.dimension}),
        checkedAt: new Date(Date.now() - 1000).toISOString()};
}

/** FIFO ограничен временем собственного child; родитель и чужие процессы не затрагиваются. */
async function readStatus(own, profile, {outside = '', timeout = 5000} = {}) {
    const config = configuration({}, own.root, profile);
    const container = {Config: {Image: config.lock.image, Labels: {'com.docker.compose.project': config.project}},
        State: {Running: true}, Mounts: [{Destination: '/root/.ollama', Source: config.data}],
        NetworkSettings: {Ports: {'11434/tcp': [{HostIp: '127.0.0.1', HostPort: String(config.port)}]}}};
    const child = spawn(process.execPath, [own.runner, own.root, profile, runtimeUrl, configUrl, outside], {
        cwd: repositoryRoot,
        env: {...process.env, PATH: own.bin + path.delimiter + process.env.PATH, REVIEW_CONTAINER_JSON: JSON.stringify([container])},
        stdio: ['ignore','pipe','pipe'],
    });
    let output = '', diagnostic = '', timedOut = false;
    child.stdout.on('data', value => {output += value;});
    child.stderr.on('data', value => {diagnostic += value;});
    const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, timeout);
    let result;
    try {
        result = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({code, signal}));
        });
    } finally {clearTimeout(timer);}
    assert.equal(timedOut, false, 'Чтение квитанции не должно зависать.');
    assert.equal(result.code, 0, diagnostic);
    assert.equal(result.signal, null);
    return JSON.parse(output.trim());
}

for (const profile of ['embedding', 'vision']) {
    test(`${profile}: валидная квитанция подтверждает свой профиль без изменения файла`, () => fixture(async own => {
        const config = configuration({}, own.root, profile);
        const bytes = JSON.stringify(receipt(config));
        await writeFile(config.receipt, bytes);
        const result = await readStatus(own, profile);
        assert.equal(result.error, undefined);
        assert.equal(result.value.state, 'verified');
        assert.equal(result.value.model, config.lock.model);
        assert.equal(result.value.checkedAt, JSON.parse(bytes).checkedAt);
        assert.equal(result.value.verificationIssue, undefined);
        assert.equal(await readFile(config.receipt, 'utf8'), bytes);
    }));

    test(`${profile}: отсутствие квитанции даёт непроверенную установленную модель`, () => fixture(async own => {
        const result = await readStatus(own, profile);
        assert.equal(result.error, undefined);
        assert.equal(result.value.state, 'unchecked');
        assert.equal(result.value.checkedAt, null);
        assert.ok(!result.value.verificationIssue);
    }));
}

for (const kind of ['malformed', 'symlink', 'outside', 'oversized', 'fifo']) {
    test(`Повреждённая квитанция ${kind}: статус не зависает и объясняет отсутствие проверки`, () => fixture(async own => {
        const config = configuration({}, own.root, 'vision');
        const embedding = configuration({}, own.root);
        const embeddingBytes = JSON.stringify(receipt(embedding));
        await writeFile(embedding.receipt, embeddingBytes);
        const bytes = JSON.stringify(receipt(config));
        let outside = '';
        if (kind === 'malformed') await writeFile(config.receipt, '{');
        if (kind === 'oversized') await writeFile(config.receipt, JSON.stringify({...receipt(config), padding: 'x'.repeat(2 * 1024 * 1024)}));
        if (kind === 'symlink' || kind === 'outside') {
            const target = kind === 'outside' ? path.join(own.temporary, 'outside.json') : path.join(config.data, 'other-receipt.json');
            await writeFile(target, bytes);
            await symlink(target, config.receipt);
            if (kind === 'outside') outside = target;
        }
        if (kind === 'fifo') {
            const result = spawnSync('mkfifo', [config.receipt], {encoding: 'utf8'});
            assert.equal(result.status, 0, result.stderr);
        }
        const result = await readStatus(own, 'vision', {outside, timeout: kind === 'fifo' ? 1500 : 5000});
        assert.equal(result.outsideReadAttempts, 0, 'Содержимое внешней квитанции читать нельзя.');
        assert.equal(result.error, undefined);
        assert.equal(result.value.state, 'unchecked');
        assert.equal(result.value.checkedAt, null);
        assert.equal(typeof result.value.verificationIssue, 'string');
        assert.match(result.value.verificationIssue, /[а-яё]/iu);
        assert.equal(await readFile(embedding.receipt, 'utf8'), embeddingBytes, 'Отказ vision не изменяет квитанцию embedding.');
    }));
}

test('Штатное освобождение владельцем блокировки перед lstat допускает новый захват без ENOENT', () => fixture(async own => {
    const config = configuration({}, own.root);
    let entered, release;
    const ownerEntered = new Promise(resolve => {entered = resolve;});
    const ownerMayFinish = new Promise(resolve => {release = resolve;});
    const owner = withControlLock(config, async () => {entered(); await ownerMayFinish;});
    await ownerEntered;
    const original = fs.promises.lstat;
    let intercepted = false, contenderRan = false;
    fs.promises.lstat = async (filename, ...args) => {
        if (!intercepted && filename === path.join(config.data, 'control.lock')) {
            intercepted = true;
            release();
            await owner;
        }
        return original(filename, ...args);
    };
    syncBuiltinESMExports();
    try {
        await withControlLock(config, async () => {contenderRan = true;});
        assert.equal(intercepted, true, 'Сценарий должен пройти через окно штатного освобождения.');
        assert.equal(contenderRan, true);
    } finally {
        fs.promises.lstat = original;
        syncBuiltinESMExports();
        release();
        await owner;
    }
}));
