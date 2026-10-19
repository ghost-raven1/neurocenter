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
