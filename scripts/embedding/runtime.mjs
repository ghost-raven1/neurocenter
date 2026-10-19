import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {mkdir,readFile,writeFile,rename,rm,lstat,statfs,open} from 'node:fs/promises';
import path from 'node:path';
import {lockedModel} from './config.mjs';
import {requestJson, pullModel, probeModel} from './client.mjs';

/** Docker вызывается без shell и не читает production-конфигурацию приложения. */
export async function docker(config, args, {inherit = false, timeout = 120000} = {}) {
    const child = spawn('docker', args, {cwd: config.root, env: {...process.env, EMBEDDING_PORT: String(config.port)}, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']});
    let output = '', diagnostic = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    try {
        return await new Promise((resolve, reject) => {
            child.once('error', () => reject(new Error('Не удалось запустить Docker. Установите и запустите Docker с Compose v2.')));
            if (!inherit) {
                child.stdout.on('data', chunk => {output += chunk; if (output.length > 1024 * 1024) child.kill();});
                child.stderr.on('data', chunk => {diagnostic = (diagnostic + chunk).slice(-2000);});
            }
            child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Docker не выполнил команду. ' + diagnostic.trim())));
        });
    } finally {clearTimeout(timer);}
}

export const compose = (config, args, options) => docker(config,
    ['compose', '--project-directory', config.root, '--project-name', config.project, '-f', path.join(config.root, 'compose.embedding.yml'), ...args], options);

/** Не позволяет смонтировать вместо проектных данных симлинк на пользовательский Ollama. */
export async function dataDirectory(config, relative = '', create = false) {
    let current = config.root;
    for (const part of ['data', 'embedding', ...relative.split('/').filter(Boolean)]) {
        current = path.join(current, part);
        if (create) {
            try {await mkdir(current, {mode: 0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
        }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталоги data/embedding должны находиться в проекте, без символьных ссылок.');
    }
    return current;
}

/** Проверяет принадлежность контейнера, фактический bind и каталог весов. */
export function assertManagedContainer(config, container) {
    const ports = container?.NetworkSettings?.Ports?.['11434/tcp'];
    if (!container?.State?.Running || container.Config?.Image !== config.lock.image
        || container.Config.Labels?.['com.docker.compose.project'] !== config.project
        || !container.Mounts?.some(mount => mount.Destination === '/root/.ollama' && path.resolve(mount.Source) === path.resolve(config.data))
        || !Array.isArray(ports) || ports.length !== 1 || ports[0].HostIp !== '127.0.0.1' || ports[0].HostPort !== String(config.port)) {
        throw new Error('Контейнер, каталог данных или порт не соответствуют проектной конфигурации. Подключение остановлено.');
    }
    return container;
}

/** Не принимает за наш сервис другой Ollama, случайно занявший тот же порт. */
export async function managedContainer(config) {
    await dataDirectory(config);
    const id = await compose(config, ['ps', '--quiet', 'embedding']);
    if (!id) throw new Error(`Проектная модель остановлена. Выполните ${config.upCommand}.`);
    const [container] = JSON.parse(await docker(config, ['inspect', id]));
    return assertManagedContainer(config, container);
}

/** Проверяет весь закреплённый комплект на диске, не загружая веса в память Node. */
export async function verifyModelFiles(config) {
    await dataDirectory(config, path.relative(config.data, path.dirname(config.manifest)));
    await dataDirectory(config, 'models/blobs');
    const manifestInfo = await lstat(config.manifest);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 128 * 1024) throw new Error('Недопустимый файл манифеста модели.');
    const manifest = await readFile(config.manifest);
    if (manifest.length > 128 * 1024 || createHash('sha256').update(manifest).digest('hex') !== config.lock.manifestSha256) {
        throw new Error('Манифест модели отличается от model.lock.json. Автоматическая замена модели запрещена.');
    }
    for (const item of [config.lock.manifest.config, ...config.lock.manifest.layers]) {
        const filename = path.join(config.data, 'models/blobs', item.digest.replace(':', '-'));
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== item.size) throw new Error('Файл модели имеет недопустимый тип или размер. Сохраните повреждённый models/ отдельно и повторно подготовьте модель в чистом каталоге.');
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(filename, {flags: constants.O_RDONLY | constants.O_NOFOLLOW})) hash.update(bytes);
        if ('sha256:' + hash.digest('hex') !== item.digest) throw new Error('SHA файла модели не совпал. Сохраните данные для диагностики и повторно подготовьте модель.');
    }
}

async function atomicReceipt(config, value) {
    const temporary = config.receipt + '.' + randomUUID() + '.next';
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await rename(temporary, config.receipt);
}

/** Статусы моделей независимы: vision требует проверки картинки, embedding — размерности. */
export function verifiedReceipt(config, receipt) {
    const checkedAt = typeof receipt?.checkedAt === 'string' ? Date.parse(receipt.checkedAt) : NaN;
    return Number.isFinite(checkedAt) && checkedAt <= Date.now() && new Date(checkedAt).toISOString() === receipt.checkedAt
        && receipt?.model === config.lock.model && receipt?.manifestSha256 === config.lock.manifestSha256 && receipt?.image === config.lock.image
        && (config.capability === 'vision' ? receipt.capability === 'vision' && receipt.visionVerified === true
            : Number.isSafeInteger(config.lock.dimension) && receipt.dimension === config.lock.dimension);
}

/** Сохраняет отметку готовности только после SHA и содержательной пробы выбранной модели. */
export async function check(config, probe = probeModel) {
    await managedContainer(config);
    await rm(config.receipt, {force: true});
    const tags = await requestJson(config.baseUrl + '/api/tags');
    if (!lockedModel(tags, config.lock)) throw new Error(`Закреплённая модель не подготовлена или заменена. Выполните ${config.upCommand}.`);
    await verifyModelFiles(config);
    const result = await probe(config);
    if (config.capability === 'vision' ? result.visionVerified !== true : result.dimension !== config.lock.dimension) throw new Error('Содержательная проверка модели не пройдена.');
    const receipt = {model: config.lock.model, manifestSha256: config.lock.manifestSha256, image: config.lock.image,
        ...(config.capability === 'vision' ? {capability: 'vision', visionVerified: true, observation: result.observation} : {dimension: result.dimension}),
        checkedAt: new Date().toISOString()};
    await atomicReceipt(config, receipt);
    return receipt;
}

/** Статус не запускает inference; время последней реальной проверки возвращается отдельно. */
export async function status(config) {
    await managedContainer(config);
    const version = await requestJson(config.baseUrl + '/api/version');
    const tags = await requestJson(config.baseUrl + '/api/tags');
    let receipt;
    try {receipt = JSON.parse(await readFile(config.receipt, 'utf8'));} catch (error) {if (error.code !== 'ENOENT') throw error;}
    const installed = lockedModel(tags, config.lock);
    const checked = installed && verifiedReceipt(config, receipt);
    return {state: checked ? 'verified' : installed ? 'unchecked' : 'missing', version: version.version,
        model: config.lock.model, capability: config.capability, dimension: config.lock.dimension, url: config.baseUrl + '/api',
        checkedAt: checked ? receipt.checkedAt : null, data: config.data};
}

/** Один управляющий процесс на checkout; после аварии незанятый PID можно безопасно заменить. */
export async function withControlLock(config, action) {
    await dataDirectory(config, '', true);
    const filename = path.join(config.data, 'control.lock');
    let handle;
    try {handle = await open(filename, 'wx', 0o600);}
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Только один процесс может перечитать и заменить устаревшую блокировку.
        const recoveryFile = filename + '.recovery';
        let recovery;
        try {recovery = await open(recoveryFile, 'wx', 0o600);}
        catch (failure) {
            if (failure.code !== 'EEXIST') throw failure;
            throw new Error('Блокировка модели восстанавливается. Повторите команду после завершения операции. При аварии проверьте control.lock.recovery.');
        }
        try {
            await recovery.writeFile(String(process.pid));
            const lockInfo = await lstat(filename);
            if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.size > 32) throw new Error('Недопустимый файл блокировки data/embedding/control.lock.');
            const pid = Number(await readFile(filename, 'utf8'));
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Некорректная блокировка data/embedding/control.lock. Проверьте незавершённую операцию.');
            let active = true;
            try {process.kill(pid, 0);} catch (probe) {if (probe.code === 'ESRCH') active = false; else throw probe;}
            if (active) throw new Error('Подготовка модели уже выполняется. Дождитесь её завершения.');
            await rm(filename); handle = await open(filename, 'wx', 0o600);
        } finally {await recovery.close(); await rm(recoveryFile, {force: true});}
    }
    try {await handle.writeFile(String(process.pid)); await handle.close(); return await action();}
    finally {await handle.close(); await rm(filename, {force: true});}
}

/** Повторный запуск использует проверенные веса; сбой загрузки допускает продолжение. */
export async function up(config, progress, probe = probeModel) {
    return withControlLock(config, async () => {
        await rm(config.receipt, {force: true});
        let cached = true;
        try {await verifyModelFiles(config);} catch (error) {
            if (error.code === 'ENOENT') cached = false; else throw error;
        }
        await docker(config, ['info', '--format', '{{.ServerVersion}}']);
        const imagePresent = await docker(config, ['image', 'inspect', config.lock.image]).then(() => true, () => false);
        const space = await statfs(config.data);
        const required = (imagePresent ? 2 : 10) * 1024 ** 3 + (cached ? 0 : config.lock.manifest.layers.reduce((sum, layer) => sum + layer.size, 0));
        if (Number(space.bavail) * Number(space.bsize) < required) throw new Error(`Для подготовки модели и образа нужно около ${Math.ceil(required / 1024 ** 3)} ГиБ свободного места.`);
        if (!cached) {
            const manifest = await requestJson(config.lock.registryManifestUrl, {timeout: 30000, limit: 128 * 1024});
            if (JSON.stringify(manifest) !== JSON.stringify(config.lock.manifest)) throw new Error('Тег модели изменился в реестре. model.lock.json нужно обновить явно.');
        }
        await compose(config, ['up', '-d', '--wait', '--wait-timeout', '90', 'embedding'], {inherit: true, timeout: 10 * 60 * 1000});
        await managedContainer(config);
        if (!cached) await pullModel(config, progress);
        return check(config, probe);
    });
}
