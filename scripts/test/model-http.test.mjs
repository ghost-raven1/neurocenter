import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestJson} from '../models/http.mjs';
import {requestJson as embeddingRequestJson, pullModel, probeModel} from '../embedding/client.mjs';
import {probeVision, visionChat} from '../vision/client.mjs';
import {visionFixture} from '../vision/image-fixture.mjs';

/** Изолированный HTTP fixture не обращается к Docker или настоящей модели. */
async function withServer(handler, action) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {await action(`http://127.0.0.1:${server.address().port}`);}
    finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}

function json(response, value, status = 200) {
    response.writeHead(status, {'content-type': 'application/json'});
    response.end(JSON.stringify(value));
}

test('HTTP принимает JSON-объект и передаёт тело POST без изменения', async () => {
    const input = {model: 'fixture', input: ['синтетический текст']};
    await withServer(async (request, response) => {
        if (request.method === 'POST') {
            assert.equal(request.headers['content-type'], 'application/json');
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            assert.deepEqual(JSON.parse(Buffer.concat(chunks)), input);
        }
        json(response, {ok: true});
    }, async base => {
        assert.deepEqual(await requestJson(base), {ok: true});
        assert.deepEqual(await embeddingRequestJson(base), {ok: true});
        assert.deepEqual(await requestJson(base, {body: input}), {ok: true});
    });
});

test('HTTP отклоняет null, массивы и примитивы понятной ошибкой JSON-контракта', async () => {
    for (const value of [null, [], true, 1, 'text']) {
        await withServer((_request, response) => json(response, value), async base => {
            await assert.rejects(requestJson(base), /Модельный сервис.*JSON-объект/);
        });
    }
});

test('Пустой HTTP 204 не раскрывает внутренний TypeError', async () => {
    await withServer((_request, response) => {response.writeHead(204); response.end();}, async base => {
        await assert.rejects(requestJson(base), /Модельный сервис.*пуст/);
    });
});

test('HTTP 503 сохраняет статус при null и пустом ответе сервиса', async () => {
    for (const body of ['null', '']) {
        await withServer((_request, response) => {response.writeHead(503); response.end(body);}, async base => {
            await assert.rejects(requestJson(base), /HTTP 503/);
        });
    }
});

test('Ошибки native и OpenAI сохраняют сообщение сервиса и ограничивают его длину', async () => {
    const detail = 'fixture unavailable: ' + 'x'.repeat(400);
    for (const error of [detail, {message: detail, type: 'api_error'}]) {
        await withServer((_request, response) => json(response, {error}, 503), async base => {
            await assert.rejects(requestJson(base), failure => {
                assert.match(failure.message, /HTTP 503\. fixture unavailable:/);
                assert.ok(!failure.message.includes('[object Object]'));
                assert.ok(failure.message.endsWith(detail.slice(0, 300)));
                assert.ok(failure.message.length < 350);
                return true;
            });
        });
    }
});

test('Ошибка провайдера внутри HTTP 200 тоже отклоняется', async () => {
    await withServer((_request, response) => json(response, {error: {message: 'fixture failure'}}), async base => {
        await assert.rejects(requestJson(base), /HTTP 200\. fixture failure/);
    });
});

test('Некорректный JSON отклоняется, а HTTP-ошибка сохраняет статус', async () => {
    for (const status of [200, 502]) {
        await withServer((_request, response) => {response.writeHead(status); response.end('{');}, async base => {
            await assert.rejects(requestJson(base), status === 200 ? /некорректный JSON/ : /HTTP 502/);
        });
    }
});

test('Превышение размера и таймаут чтения закрывают HTTP-соединение', async () => {
    for (const mode of ['large', 'headers', 'body']) {
        let closed;
        const closure = new Promise(resolve => {closed = resolve;});
        await withServer((_request, response) => {
            response.on('close', closed);
            if (mode !== 'headers') {
                response.writeHead(200); response.flushHeaders();
                response.write(mode === 'large' ? '{"text":"' + 'x'.repeat(200) : '{');
            }
        }, async base => {
            await assert.rejects(requestJson(base, {limit: 20, timeout: mode === 'large' ? 1000 : 40}),
                mode === 'large' ? /размер/ : undefined);
            const deadline = setTimeout(() => closed(false), 1000);
            try {assert.notEqual(await closure, false, 'Соединение осталось открытым после отказа');}
            finally {clearTimeout(deadline);}
        });
    }
});

test('HTTP не переходит по redirect даже на тот же loopback-сервер', async () => {
    let redirected = false;
    await withServer((request, response) => {
        if (request.url === '/target') {redirected = true; json(response, {ok: true});}
        else {response.writeHead(302, {location: '/target'}); response.end();}
    }, async base => {
        await assert.rejects(requestJson(base));
        assert.equal(redirected, false);
    });
});

test('NDJSON ограничивает запись по UTF-8 байтам, включая незавершённую строку', async () => {
    const record = JSON.stringify({status: '雪'.repeat(30000)});
    assert.ok(record.length < 65536); assert.ok(Buffer.byteLength(record) > 65536);
    for (const suffix of ['', '\n{"status":"success"}\n']) {
        await withServer((_request, response) => response.end(record + suffix), async baseUrl => {
            await assert.rejects(pullModel({baseUrl, lock: {model: 'fixture'}}), /Слишком длинная запись/);
        });
    }
    const boundary = JSON.stringify({status: '雪'.repeat(21841)});
    assert.equal(Buffer.byteLength(boundary), 65536);
    await withServer((_request, response) => response.end(boundary + '\n{"status":"success"}\n'), async baseUrl => {
        await pullModel({baseUrl, lock: {model: 'fixture'}});
    });
});

test('NDJSON требует success в последней непустой записи', async () => {
    await withServer((_request, response) => response.end('{"status":"success"}\n{"status":"pulling manifest"}\n'), async baseUrl => {
        await assert.rejects(pullModel({baseUrl, lock: {model: 'fixture'}}), /прервана/);
    });
    await withServer((_request, response) => {
        const line = Buffer.from('{"status":"загрузка"}\n{"status":"success"}\n\n');
        const split = line.indexOf(Buffer.from('загрузка')) + 1;
        response.write(line.subarray(0, split)); setTimeout(() => response.end(line.subarray(split)), 5);
    }, async baseUrl => {
        const values = [];
        await pullModel({baseUrl, lock: {model: 'fixture'}}, value => values.push(value));
        assert.deepEqual(values, [{status: 'загрузка'}, {status: 'success'}]);
    });
});

test('NDJSON отклоняет null и повреждённую запись понятной ошибкой', async () => {
    for (const line of ['null\n', '{\n']) {
        await withServer((_request, response) => response.end(line), async baseUrl => {
            await assert.rejects(pullModel({baseUrl, lock: {model: 'fixture'}}), /Загрузка модели: некорректная запись/);
        });
    }
});

test('Проба embedding проверяет имя модели, если сервис его вернул', async () => {
    for (const model of ['different-model', null, false]) {
        await withServer((_request, response) => json(response, {model, embeddings: [[1, 2], [3, 4]]}), async baseUrl => {
            await assert.rejects(probeModel({baseUrl, lock: {model: 'fixture', dimension: 2}}), /модел/);
        });
    }
    for (const model of [{model: 'fixture'}, {}]) {
        await withServer((_request, response) => json(response, {...model, embeddings: [[1, 2], [3, 4]]}), async baseUrl => {
            assert.deepEqual(await probeModel({baseUrl, lock: {model: 'fixture', dimension: 2}}), {dimension: 2, vectors: 2});
        });
    }
});

test('Проба embedding отклоняет повреждённые векторы из настоящего HTTP JSON', async () => {
    for (const embeddings of [null, [], [[1, 2]], [[1, 2], [3]], [[1, 2], [null, 4]],
        [[1, 2], ['3', 4]], [[1, 2], [0, 0]], [[1, 2], [1e-50, 1e-50]], [[1, 2], [1e100, 4]]]) {
        await withServer((_request, response) => json(response, {embeddings}), async baseUrl => {
            await assert.rejects(probeModel({baseUrl, lock: {model: 'fixture', dimension: 2}}), /размерности 2/);
        });
    }
});

/** Hook заменяет только принадлежность контейнера; все HTTP-проверки остаются настоящими. */
async function withVision({capabilities = ['vision'], content = '{"number":"42","color":"red"}'} = {}, action) {
    const calls = [], lock = {model: 'fixture', manifestSha256: 'fixture-digest'};
    let managed = 0;
    await withServer(async (request, response) => {
        calls.push(request.url);
        if (request.url === '/api/show') return json(response, {capabilities});
        if (request.url === '/api/tags') return json(response, {models: [{name: lock.model, digest: lock.manifestSha256}]});
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        assert.equal(input.model, lock.model);
        if (request.url === '/api/chat') {
            assert.equal(input.options.num_predict, 64);
            assert.equal(input.stream, false);
            json(response, {model: lock.model, message: {content}, done: true, done_reason: 'stop'});
        } else json(response, {model: lock.model, choices: [{message: {content}, finish_reason: 'length'}]});
    }, async baseUrl => {
        const config = {capability: 'vision', baseUrl, lock};
        await action(config, async actual => {assert.equal(actual, config); managed++;}, calls, () => managed);
    });
}

test('Проба vision отклоняет capabilities не в виде массива до вызова runtime', async () => {
    for (const capabilities of ['vision', {}, 1, null]) {
        await withVision({capabilities}, async (config, ensureManaged, calls, managed) => {
            await assert.rejects(probeVision(config, ensureManaged), /Модель не заявляет поддержку изображений/);
            assert.deepEqual(calls, ['/api/show']); assert.equal(managed(), 0);
        });
    }
});

test('Проба vision требует JSON-объект ровно с числом и цветом своей картинки', async () => {
    for (const content of ['null', '[]', '{', '{"number":"42","color":"red","extra":true}',
        '{"number":42,"color":"red"}', '{"number":"17","color":"blue"}']) {
        await withVision({content}, async (config, ensureManaged, calls, managed) => {
            await assert.rejects(probeVision(config, ensureManaged), /Модель.*(?:картинк|формат)/);
            assert.deepEqual(calls, ['/api/show', '/api/tags', '/api/chat']); assert.equal(managed(), 1);
        });
    }
    await withVision({}, async (config, ensureManaged) => {
        assert.deepEqual(await probeVision(config, ensureManaged), {visionVerified: true, observation: {number: '42', color: 'red'}});
    });
});

test('OpenAI HTTP сохраняет явное усечение ответа и проверку runtime', async () => {
    await withVision({content: 'A synthetic image.'}, async (config, ensureManaged, calls, managed) => {
        const result = await visionChat(config, {image: visionFixture(), question: 'Describe this image.', protocol: 'openai'}, ensureManaged);
        assert.deepEqual(result, {model: 'fixture', text: 'A synthetic image.', truncated: true});
        assert.deepEqual(calls, ['/api/tags', '/v1/chat/completions']); assert.equal(managed(), 1);
    });
});
