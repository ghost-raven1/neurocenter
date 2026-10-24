import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddingError, protectedEmbedder, strictRetriever, requireSuccessfulIndex } from '../adapters/rag-errors.mjs';

const secret = 'fixture-sensitive-provider-response';
const swallowingRetrieve = async (_query, embedder, store) => {
    try { return await store.searchWithFilter((await embedder.embed(['query']))[0]); }
    catch { return []; }
};

for (const status of [401, 503]) {
    test(`Подавленный upstream HTTP ${status} становится безопасной ошибкой без повторного embedding`, async () => {
        let calls = 0;
        const embedder = protectedEmbedder({ embed: async () => { calls++; throw new Error(`OpenAI embedding failed (${status}): ${secret}`); } });
        await assert.rejects(strictRetriever(swallowingRetrieve)('query', embedder, {}), error => {
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.ok(!error.message.includes(secret));
            return true;
        });
        assert.equal(calls, 1);
    });
}

test('Настоящие нулевые результаты остаются успешными', async () => {
    const result = await strictRetriever(swallowingRetrieve)('query', { embed: async () => [[1, 0]] }, { searchWithFilter: async () => [] });
    assert.deepEqual(result, []);
});

test('Отказ локального индекса не превращается в отсутствие результатов', async () => {
    await assert.rejects(strictRetriever(swallowingRetrieve)('query', { embed: async () => [[1, 0]] }, {
        searchWithFilter: async () => { throw new Error(secret); },
    }), error => { assert.match(error.message, /Ошибка локального индекса/); assert.ok(!error.message.includes(secret)); return true; });
});

test('Перехват не теряет this у методов класса и изолирован между параллельными запросами', async () => {
    class Embedder {
        #vector = [1, 0];
        async embed() { return [this.#vector]; }
    }
    const retrieve = strictRetriever(swallowingRetrieve);
    const embedder = protectedEmbedder(new Embedder());
    const results = await Promise.allSettled([
        retrieve('query', embedder, { searchWithFilter: async () => [] }),
        retrieve('query', embedder, { searchWithFilter: async () => { throw new Error(secret); } }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.deepEqual(results[0].value, []);
    assert.equal(results[1].status, 'rejected');
});

test('Синхронный отказ keyword поиска также остаётся видимой ошибкой', async () => {
    const retrieve = strictRetriever(async (_query, _embedder, _store, options) => {
        try { return options.keywordIndex.search('query'); }
        catch { return []; }
    });
    await assert.rejects(retrieve('query', {}, {}, { keywordIndex: { search() { throw new Error(secret); } } }), /Ошибка локального индекса/);
});

test('Санитизация сохраняет признаки для retry и разделения слишком больших embedding batch', () => {
    assert.match(embeddingError(new Error(`HTTP failure (400): exceed_context_size_error ${secret}`)).message, /HTTP 400.*exceed_context_size_error/);
    assert.match(embeddingError(new Error(`Request timed out ${secret}`)).message, /timed out/);
    assert.ok(!embeddingError(new Error(secret)).message.includes(secret));
});

for (const stats of [{ embeddingUnavailable: true, embeddingFailures: 0, finalCount: 0 }, { embeddingUnavailable: false, embeddingFailures: 2, finalCount: 3 }]) {
    test(`Незавершённая индексация сохраняет статистику и помечается ошибкой: ${JSON.stringify(stats)}`, () => {
        assert.throws(() => requireSuccessfulIndex(stats), error => {
            assert.equal(error.indexStats, stats);
            assert.match(error.message, /Индексирование не завершено/);
            return true;
        });
    });
}

test('Пустой или неизменённый успешный проход не считается отказом', () => {
    const stats = { embeddingUnavailable: false, embeddingFailures: 0, finalCount: 0, unchangedFiles: 0 };
    assert.equal(requireSuccessfulIndex(stats), stats);
});

const hostedConfig = {[Symbol.for('neurocenter.hosted-rag')]: 'verified-fixture-profile'};
const inputBudget = 256 * 1024;
function controlledProvider() {
    const calls = [];
    const provider = {model: 'fixture', async embed(texts, ...args) {
        assert.equal(this, provider); calls.push({texts: [...texts], args});
        return texts.map(text => [Number(text.split(':', 1)[0])]);
    }};
    return {provider, calls};
}
test('Hosted JSON budget сохраняет точную границу и не делит допустимый запрос', async () => {
    const {provider, calls} = controlledProvider();
    const text = '0:' + 'x'.repeat(inputBudget - 6);
    assert.equal(Buffer.byteLength(JSON.stringify([text])), inputBudget);
    assert.deepEqual(await protectedEmbedder(provider, hostedConfig).embed([text]), [[0]]);
    assert.equal(calls.length, 1);
});
for (const tail of ['x'.repeat(inputBudget), '漢'.repeat(100000), '\0'.repeat(50000)]) {
    test('Oversized single отклоняет весь hosted запрос до первого вызова: ' + JSON.stringify({length: tail.length, firstCode: tail.charCodeAt(0)}), async () => {
        const {provider, calls} = controlledProvider();
        await assert.rejects(protectedEmbedder(provider, hostedConfig).embed(['0:small', '1:' + tail]), /HTTP 422/);
        assert.equal(calls.length, 0);
    });
}
test('Hosted packer учитывает Unicode/JSON escaping и сохраняет order, this и все аргументы', async () => {
    const {provider, calls} = controlledProvider(), controller = new AbortController();
    const options = Object.freeze({signal: controller.signal, custom: 'preserved'});
    const texts = Object.freeze(['0:' + '漢'.repeat(40000), '1:' + '\0'.repeat(20000), '2:' + '\\"'.repeat(30000)]);
    assert.deepEqual(await protectedEmbedder(provider, hostedConfig).embed(texts, 'document', options, undefined), [[0], [1], [2]]);
    assert.equal(calls.length, 2); assert.deepEqual(calls.flatMap(call => call.texts), texts);
    for (const call of calls) {assert.ok(Buffer.byteLength(JSON.stringify(call.texts)) <= inputBudget); assert.equal(call.args[0], 'document'); assert.equal(call.args[1], options); assert.equal(call.args.length, 3);}
});
test('Hosted count64 ограничивает подзапрос, external provider без marker сохраняет исходный вызов', async () => {
    const texts = Array.from({length: 65}, (_, index) => index + ':x');
    const hosted = controlledProvider();
    assert.deepEqual(await protectedEmbedder(hosted.provider, hostedConfig).embed(texts), texts.map((_, index) => [index]));
    assert.deepEqual(hosted.calls.map(call => call.texts.length), [64, 1]);
    const external = controlledProvider(); await protectedEmbedder(external.provider, {}).embed(texts);
    assert.deepEqual(external.calls.map(call => call.texts.length), [65]);
});
test('Ошибка второго подзапроса не публикует частичные векторы и не запускает третий', async () => {
    let calls = 0;
    const provider = {async embed(texts) {if (++calls === 2) throw new Error('upstream (503) ' + secret); return texts.map(() => [1]);}};
    const texts = [0, 1, 2].map(index => index + ':' + 'x'.repeat(140000));
    await assert.rejects(protectedEmbedder(provider, hostedConfig).embed(texts), error => {
        assert.match(error.message, /HTTP 422/); assert.ok(!error.message.includes(secret)); return true;
    });
    assert.equal(calls, 2);
});
test('Первый503 сохраняет прежнюю классификацию без нового внутреннего retry', async () => {
    let calls = 0; const provider = {async embed() {calls++; throw new Error('upstream (503) ' + secret);}};
    await assert.rejects(protectedEmbedder(provider, hostedConfig).embed(['x']), /HTTP 503/);
    assert.equal(calls, 1);
});
test('Abort на await второго подзапроса сохраняет signal, отбрасывает результат и запрещает третий', async () => {
    const controller = new AbortController(); let calls = 0, enter;
    const entered = new Promise(resolve => {enter = resolve;});
    const provider = {async embed(texts, purpose, options) {
        calls++; assert.equal(purpose, 'document'); assert.equal(options.signal, controller.signal);
        if (calls === 2) return new Promise((_resolve, reject) => {enter(); options.signal.addEventListener('abort', () => reject(new DOMException(secret, 'AbortError')), {once: true});});
        return texts.map(() => [1]);
    }};
    const result = protectedEmbedder(provider, hostedConfig).embed([0, 1, 2].map(index => index + ':' + 'x'.repeat(140000)), 'document', {signal: controller.signal});
    assert.equal(await Promise.race([entered.then(() => true), result.then(() => false, () => false)]), true, 'The second bounded subrequest must enter before cancellation'); controller.abort();
    await assert.rejects(result, error => {assert.equal(error.name, 'AbortError'); assert.match(error.message, /HTTP 422/); assert.ok(!error.message.includes(secret)); return true;});
    assert.equal(calls, 2);
});
test('Уже отменённый hosted запрос не вызывает провайдер', async () => {
    const {provider, calls} = controlledProvider(); const controller = new AbortController(); controller.abort();
    await assert.rejects(protectedEmbedder(provider, hostedConfig).embed(['x'], 'document', {signal: controller.signal}), {name: 'AbortError'});
    assert.equal(calls.length, 0);
});
test('Неверное число векторов подзапроса не возвращается как частичный успех', async () => {
    let calls = 0;
    await assert.rejects(protectedEmbedder({async embed() {calls++; return [];}}, hostedConfig).embed(['x']), /HTTP 422/);
    assert.equal(calls, 1);
});
