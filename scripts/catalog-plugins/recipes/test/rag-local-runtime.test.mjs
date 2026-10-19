import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLocalRuntimeProfile } from '../adapters/rag-local-runtime.mjs';

const config = (overrides = {}) => ({
    embedding: { provider: 'ollama', model: 'qwen3-embedding:4b', baseUrl: 'http://127.0.0.1:11435/api', timeoutMs: 30_000, ...overrides },
    indexing: { embedBatchSize: 100, embedConcurrency: 3, concurrency: 8, includeExtensions: ['.ts'] },
    description: { enabled: false },
});

for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    for (const suffix of ['/api', '/api/']) {
        test(`Проектная CPU-модель получает ограниченный профиль: ${host}${suffix}`, () => {
            const before = config({ baseUrl: `http://${host}:11435${suffix}` });
            const snapshot = structuredClone(before);
            Object.freeze(before); Object.freeze(before.embedding); Object.freeze(before.indexing);
            const after = applyLocalRuntimeProfile(before);
            assert.equal(after.embedding.timeoutMs, 120_000);
            assert.equal(after.indexing.embedBatchSize, 1);
            assert.equal(after.indexing.embedConcurrency, 1);
            assert.equal(after.indexing.concurrency, 8);
            assert.deepEqual(after.indexing.includeExtensions, ['.ts']);
            assert.equal(after.description, before.description);
            assert.deepEqual(before, snapshot);
        });
    }
}

for (const overrides of [
    { provider: 'openai' }, { model: 'qwen3-embedding:0.6b' }, { model: 'qwen3-embedding:4b-custom' },
    { baseUrl: 'http://127.0.0.1:11434/api' }, { baseUrl: 'http://127.0.0.1:11436/api' },
    { baseUrl: 'http://embedding.example.test:11435/api' }, { baseUrl: 'http://127.0.0.2:11435/api' },
    { baseUrl: 'https://127.0.0.1:11435/api' }, { baseUrl: 'http://127.0.0.1:11435' },
    { baseUrl: 'http://127.0.0.1:11435/api/embed' }, { baseUrl: 'http://127.0.0.1:11435/api?mode=other' },
    { baseUrl: 'http://127.0.0.1:11435/api?' }, { baseUrl: 'http://127.0.0.1:11435/api#' },
    { baseUrl: 'http://127.0.0.1:11435/api#other' }, { baseUrl: 'http://user:password@127.0.0.1:11435/api' },
    { baseUrl: 'invalid-url' },
]) {
    test(`Остальные подключения сохраняют прежний timeout и параметры индексации: ${JSON.stringify(overrides)}`, () => {
        const before = config(overrides);
        const snapshot = structuredClone(before);
        assert.equal(applyLocalRuntimeProfile(before), before);
        assert.deepEqual(before, snapshot);
        assert.equal(before.embedding.timeoutMs, 30_000);
        assert.equal(before.indexing.embedBatchSize, 100);
        assert.equal(before.indexing.embedConcurrency, 3);
    });
}

test('Проектный CPU-профиль ограничивает явно заданные batch и concurrency только в памяти', () => {
    const before = config();
    before.indexing.embedBatchSize = 20; before.indexing.embedConcurrency = 5;
    const after = applyLocalRuntimeProfile(before);
    assert.equal(after.indexing.embedBatchSize, 1); assert.equal(after.indexing.embedConcurrency, 1);
    assert.equal(before.indexing.embedBatchSize, 20); assert.equal(before.indexing.embedConcurrency, 5);
});
