import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {privateSnapshotFile} from '../snapshots/control.mjs';

const names = ['ENDPOINT', 'REGION', 'ACCESS_KEY', 'SECRET_KEY', 'PROJECT_BUCKET', 'PERSONAL_BUCKET'];

/** Probe configuration and private buckets before the running application is stopped. */
async function preflight(root, supplied, environment, dependencies) {
    const read = async name => supplied[name] || (await privateSnapshotFile(supplied[name + '_FILE'], 65536)).toString('utf8').trim();
    const config = {endpoint: supplied.CHAT_S3_ENDPOINT, region: supplied.CHAT_S3_REGION || 'us-east-1',
        projectBucket: supplied.CHAT_S3_PROJECT_BUCKET, personalBucket: supplied.CHAT_S3_PERSONAL_BUCKET,
        accessKey: await read('CHAT_S3_ACCESS_KEY'), secretKey: await read('CHAT_S3_SECRET_KEY')};
    if (dependencies.probe) {await dependencies.probe(config); return;}
    const {ChatObjectStorage} = createRequire(path.join(root, 'services/catalog-service/package.json'))('./dist/model-chat/chat-object-storage.js');
    await new ChatObjectStorage(config, {environment}).initialize();
}

/** Keep S3 credentials in Catalog only; an external configuration never starts a local store. */
export async function prepareDevChatStorage(root, environment = process.env, dependencies = {}) {
    const supplied = Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith('CHAT_S3_') && environment[name]));
    if (Object.keys(supplied).length) {
        for (const name of names.filter(name => name !== 'REGION')) {
            const key = 'CHAT_S3_' + name;
            if (!supplied[key] && !(['ACCESS_KEY', 'SECRET_KEY'].includes(name) && supplied[key + '_FILE'])) throw new Error('Заполните ' + key + ' для внешнего хранилища чата.');
            if (supplied[key] && supplied[key + '_FILE']) throw new Error('Задайте только ' + key + '_FILE, без ' + key);
        }
        for (const name of ['CHAT_S3_ACCESS_KEY_FILE', 'CHAT_S3_SECRET_KEY_FILE']) if (supplied[name]) supplied[name] = path.resolve(root, supplied[name]);
        await preflight(root, supplied, environment, dependencies);
        return supplied;
    }
    const port = Number(environment.CHAT_DEV_S3_PORT || 19010);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CHAT_DEV_S3_PORT: нужен порт от 1024 до 65535.');
    const directory = path.join(root, '.run/chat-storage');
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const access = path.join(directory, 'access-key'), secret = path.join(directory, 'secret-key');
    const project = 'neurocenter-chat-' + createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 10);
    const run = dependencies.run || spawnSync;
    const present = await Promise.all([access, secret].map(async file => {try {await fs.lstat(file); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}}));
    if (!present.every(Boolean)) {
        const volume = run('docker', ['volume', 'inspect', project + '_chat-files'], {cwd: root, env: environment, stdio: 'ignore', timeout: 15000});
        if (present.some(Boolean) || volume.status === 0) throw new Error('Ключи существующего хранилища чата потеряны. Восстановите исходные файлы; новые ключи не создаются.');
    }
    for (const [file, value] of [[access, 'neurocenter-' + randomBytes(8).toString('hex')], [secret, randomBytes(32).toString('hex')]]) {
        try {await fs.writeFile(file, value + '\n', {flag: 'wx', mode: 0o600});} catch (error) {if (error.code !== 'EEXIST') throw error;}
        const bytes = await privateSnapshotFile(file, 1024);
        if (!/^[A-Za-z0-9-]{16,128}\n?$/.test(bytes.toString())) throw new Error('Некорректный локальный ключ хранилища чата; исходный файл сохранён.');
    }
    const started = run('docker', ['compose', '--project-name', project, '-f', path.join(root, 'compose.chat-storage.dev.yml'), 'up', '-d'], {
        cwd: root, env: {...environment, CHAT_DEV_S3_PORT: String(port), CHAT_DEV_S3_ACCESS_KEY_FILE: access, CHAT_DEV_S3_SECRET_KEY_FILE: secret}, stdio: 'inherit', timeout: 120000,
    });
    if (started.error || started.status !== 0) throw new Error('Локальное S3-хранилище чата не запущено; прежние сервисы сохранены.');
    const request = dependencies.fetch || fetch;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {const response = await request(`http://127.0.0.1:${port}/minio/health/ready`, {signal: AbortSignal.timeout(1000)}); if (response.ok) {ready = true; break;}} catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Локальное S3-хранилище чата не готово; прежние сервисы сохранены.');
    const suppliedLocal = {CHAT_S3_ENDPOINT: `http://127.0.0.1:${port}`, CHAT_S3_REGION: 'us-east-1', CHAT_S3_ACCESS_KEY_FILE: access, CHAT_S3_SECRET_KEY_FILE: secret,
        CHAT_S3_PROJECT_BUCKET: 'neurocenter-chat-projects', CHAT_S3_PERSONAL_BUCKET: 'neurocenter-chat-personal'};
    await preflight(root, suppliedLocal, environment, dependencies);
    return suppliedLocal;
}
