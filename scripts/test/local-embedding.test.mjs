import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile,readFile,access,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configuration,lockedModel} from '../embedding/config.mjs';
import {requestJson,pullModel,validateVectors,probeModel} from '../embedding/client.mjs';
import {verifyModelFiles,withControlLock,up,assertManagedContainer} from '../embedding/runtime.mjs';

async function server(handler, action) {
    const instance = http.createServer(handler);
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    try {await action('http://127.0.0.1:' + instance.address().port);}
    finally {instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve));}
}

async function fixture(action) {
    const root = await mkdtemp(path.join(tmpdir(), 'nc-local-embedding-'));
    try {await action(configuration({}, root));}
    finally {await rm(root, {recursive: true, force: true});}
}

test('Проектные пути и порт не используют глобальный Ollama', () => {
    const first = configuration({}, '/tmp/project-one'), second = configuration({}, '/tmp/project-two');
    assert.equal(first.baseUrl, 'http://127.0.0.1:11435');
    assert.equal(first.data, '/tmp/project-one/data/embedding');
    assert.notEqual(first.project, second.project);
    for (const port of ['11434', '0', '65536', '11435.1', 'garbage']) assert.throws(() => configuration({EMBEDDING_PORT: port}));
});

test('Готовность требует закреплённый digest, имени модели недостаточно', () => {
    const cfg = configuration();
    assert.equal(lockedModel({models: [{name: cfg.lock.model, digest: cfg.lock.manifestSha256}]}), true);
    assert.equal(lockedModel({models: [{name: cfg.lock.model, digest: 'a'.repeat(64)}]}), false);
    assert.equal(lockedModel({models: []}), false);
});

test('Чужой порт или сетевой bind не принимается за проектный контейнер', () => {
    const config = configuration({}, '/tmp/project');
    const container = {State: {Running: true}, Config: {Image: config.lock.image, Labels: {'com.docker.compose.project': config.project}},
        Mounts: [{Destination: '/root/.ollama', Source: config.data}], NetworkSettings: {Ports: {'11434/tcp': [{HostIp: '127.0.0.1', HostPort: '11435'}]}}};
    assert.equal(assertManagedContainer(config, container), container);
    for (const port of ['11434', '11436']) assert.throws(() => assertManagedContainer({...config, port}, container));
    container.NetworkSettings.Ports['11434/tcp'][0].HostIp = '0.0.0.0';
    assert.throws(() => assertManagedContainer(config, container));
});

test('Симлинк data/embedding не позволяет затронуть внешний каталог', async () => fixture(async config => {
    const outside = path.join(config.root, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'readiness.json'), 'private fixture');
    await mkdir(path.join(config.root, 'data'));
    await symlink(outside, config.data);
    await assert.rejects(up(config), /символьных ссылок/);
    assert.equal(await readFile(path.join(outside, 'readiness.json'), 'utf8'), 'private fixture');
    await assert.rejects(access(path.join(outside, 'control.lock')));
}));

test('Ответ эмбеддингов проверяется целиком до сохранения готовности', () => {
    assert.deepEqual(validateVectors({embeddings: [[1, 2], [3, 4]]}, 2, 2), [[1, 2], [3, 4]]);
    for (const vectors of [[], [[1, 2]], [[1, 2], [3]], [[1, 2], [NaN, 4]], [[1, 2], [Infinity, 4]], [[1, 2], [1e100, 4]], [[1, 2], [0, 0]], [[1, 2], [1e-50, 1e-50]], [[1, 2], ['3', 4]]]) {
        assert.throws(() => validateVectors({embeddings: vectors}, 2, 2));
    }
});

test('HTTP ограничивает тело и время чтения, не следует перенаправлениям', async () => {
    await server((req, res) => {
        if (req.url === '/redirect') {res.writeHead(302, {location: '/ok'}); res.end();}
        else if (req.url === '/slow') {res.writeHead(200, {'content-type': 'application/json'}); res.write('{');}
        else res.end(JSON.stringify({text: 'x'.repeat(200)}));
    }, async base => {
        await assert.rejects(requestJson(base + '/ok', {limit: 20}), /размер/);
        await assert.rejects(requestJson(base + '/slow', {timeout: 30}));
        await assert.rejects(requestJson(base + '/redirect'));
    });
});

test('Загрузка принимает дроблённый NDJSON и требует финальный success', async () => {
    await server((req, res) => {
        res.write('{"status":"pull');
        res.end(req.url === '/api/pull' ? 'ing","total":100,"completed":50}\n{"status":"success"}' : 'ing"}\n');
    }, async baseUrl => {
        const values = [];
        await pullModel({baseUrl, lock: {model: 'fixture'}}, value => values.push(value));
        assert.equal(values.at(-1).status, 'success');
        await assert.rejects(pullModel({baseUrl: baseUrl + '/incomplete', lock: {model: 'fixture'}}), /прервана/);
    });
});

test('Ошибки и слишком длинные записи загрузки не считаются готовностью', async () => {
    for (const body of ['{"error":"fixture failure"}\n', JSON.stringify({status: 'x'.repeat(65537)}) + '\n']) {
        await server((_req, res) => res.end(body), async baseUrl => {
            await assert.rejects(pullModel({baseUrl, lock: {model: 'fixture'}}));
        });
    }
});

test('Реальная HTTP-проба передаёт только локальные тестовые тексты и проверяет размерность', async () => {
    await server(async (req, res) => {
        assert.equal(req.url, '/api/embed');
        const chunks = []; for await (const part of req) chunks.push(part);
        const value = JSON.parse(Buffer.concat(chunks));
        assert.equal(value.model, 'fixture'); assert.equal(value.input.length, 2); assert.equal(value.truncate, false);
        res.end(JSON.stringify({embeddings: [[1, 2], [3, 4]]}));
    }, async baseUrl => {
        assert.deepEqual(await probeModel({baseUrl, lock: {model: 'fixture', dimension: 2}}), {dimension: 2, vectors: 2});
        await assert.rejects(probeModel({baseUrl, lock: {model: 'fixture', dimension: 3}}), /размерности 3/);
    });
});

test('SHA проверяется для всех файлов; повреждённый комплект не вызывает Docker или загрузку', async () => fixture(async config => {
    const bytes = Buffer.from('fixture weights'), digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const item = {digest, size: bytes.length};
    const manifest = JSON.stringify({config: item, layers: [item]});
    config.lock = {...config.lock, manifest: {config: item, layers: [item]}, manifestSha256: createHash('sha256').update(manifest).digest('hex')};
    await mkdir(path.dirname(config.manifest), {recursive: true});
    await mkdir(path.join(config.data, 'models/blobs'), {recursive: true});
    await writeFile(config.manifest, manifest);
    const blob = path.join(config.data, 'models/blobs', digest.replace(':', '-'));
    await writeFile(blob, bytes); await verifyModelFiles(config);
    await writeFile(blob, Buffer.from('broken! weights'));
    await assert.rejects(up(config), /SHA|размер/);
    await assert.rejects(access(path.join(config.data, 'control.lock')));
}));

test('Параллельная операция отклоняется, исключение освобождает блокировку, мёртвый PID восстанавливается', async () => fixture(async config => {
    await withControlLock(config, async () => {
        await assert.rejects(withControlLock(config, async () => {}), /уже выполняется/);
    });
    await assert.rejects(withControlLock(config, async () => {throw new Error('fixture failed');}), /fixture failed/);
    await assert.rejects(access(path.join(config.data, 'control.lock')));
    await writeFile(path.join(config.data, 'control.lock'), '2147483647');
    await withControlLock(config, async () => assert.equal(await readFile(path.join(config.data, 'control.lock'), 'utf8'), String(process.pid)));
}));

test('Параллельное восстановление мёртвого PID не допускает двух управляющих операций', async () => fixture(async config => {
    await mkdir(config.data, {recursive: true});
    for (let round = 0; round < 20; round++) {
        await writeFile(path.join(config.data, 'control.lock'), '2147483647');
        let active = 0, maximum = 0;
        const results = await Promise.allSettled(Array.from({length: 4}, () => withControlLock(config, async () => {
            maximum = Math.max(maximum, ++active);
            await new Promise(resolve => setTimeout(resolve, 3));
            active--;
        })));
        assert.equal(maximum, 1);
        assert.ok(results.some(result => result.status === 'fulfilled'));
    }
}));
