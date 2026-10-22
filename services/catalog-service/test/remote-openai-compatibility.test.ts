import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteModelClient } from '../src/models/remote-model-client';
import { assertRemoteModelOptions, remoteModelOptions } from '../src/models/remote-model-options';
import { remoteVerificationDigest } from '../src/models/remote-model-validation';
import type { IModel } from '../src/models/model.types';
import type { IRemoteModelConnection } from '../src/models/remote-model.types';

const model: IModel = { id: 'compatibility-fixture', name: 'Fixture', description: '', runtime: 'remote-openai',
    model: 'provider-alias', modelVersion: 'fixture-v1', capability: 'chat', dimension: null,
    manifestSha256: null, verificationSha256: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };

describe('Явный контракт OpenAI-совместимого API', () => {
    it('Сохраняет точное имя ответа и выбранный параметр лимита без произвольного JSON', () => {
        const options = { responseModel: 'provider-snapshot-v1', tokenLimitParameter: 'max_completion_tokens', maxOutputTokens: 4096 };
        expect(remoteModelOptions(options)).toEqual(options);
        expect(() => assertRemoteModelOptions(model, remoteModelOptions(options))).not.toThrow();
    });
    it.each([null, '', ' model', 'model ', ['model'], 'https://api.example.test/model', 'x'.repeat(201)].map(responseModel => ({ responseModel })))('Отклоняет некорректное имя ответа $responseModel', ({ responseModel }) => {
        expect(() => remoteModelOptions({ responseModel })).toThrow();
    });
    it.each([null, '', ['max_tokens'], 'max_output_tokens', 42].map(tokenLimitParameter => ({ tokenLimitParameter })))('Отклоняет неоднозначный параметр лимита $tokenLimitParameter', ({ tokenLimitParameter }) => {
        expect(() => remoteModelOptions({ tokenLimitParameter })).toThrow();
    });
    it('Разрешает имя ответа для embedding, сохраняя запрет generation options', () => {
        const embedding = { ...model, capability: 'embedding' as const };
        expect(() => assertRemoteModelOptions(embedding, remoteModelOptions({ responseModel: 'embedding-v1' }))).not.toThrow();
        expect(() => assertRemoteModelOptions(embedding, remoteModelOptions({ responseModel: 'embedding-v1', temperature: 0 }))).toThrow('Embedding');
        expect(() => assertRemoteModelOptions(embedding, remoteModelOptions({ tokenLimitParameter: 'max_tokens' }))).toThrow();
    });
    it('Не применяет OpenAI compatibility к Ollama', () => {
        for (const options of [{ responseModel: 'snapshot-v1' }, { tokenLimitParameter: 'max_completion_tokens' }]) {
            expect(() => assertRemoteModelOptions({ runtime: 'remote-ollama', capability: 'chat' }, remoteModelOptions(options))).toThrow();
        }
    });
    it('Включает совместимость в pin, сохраняя существующий pin пустых настроек', () => {
        const connection = { modelId: model.id, revision: 1, baseUrl: 'https://models.example.test/v1', requestDimensions: false };
        const original = remoteVerificationDigest(model, connection, null);
        expect(remoteVerificationDigest(model, { ...connection, options: {} }, null)).toBe(original);
        const options = remoteModelOptions({ responseModel: 'snapshot-v1', tokenLimitParameter: 'max_completion_tokens' });
        const configured = remoteVerificationDigest(model, { ...connection, options }, null);
        expect(configured).not.toBe(original);
        expect(remoteVerificationDigest(model, { ...connection, options: remoteModelOptions({ tokenLimitParameter: 'max_completion_tokens', responseModel: 'snapshot-v1' }) }, null)).toBe(configured);
        expect(remoteVerificationDigest(model, { ...connection, options: remoteModelOptions({ ...options, responseModel: 'snapshot-v2' }) }, null)).not.toBe(configured);
        expect(remoteVerificationDigest(model, { ...connection, options: remoteModelOptions({ ...options, tokenLimitParameter: 'max_tokens' }) }, null)).not.toBe(configured);
    });
});

describe('Настоящий HTTP с явной совместимостью', () => {
    let server: http.Server, connection: IRemoteModelConnection;
    let received: Array<{ url: string | undefined; body: Record<string, unknown>; authorization: string | undefined }>;
    let answer: Record<string, unknown>;
    beforeEach(async () => {
        received = [];
        answer = { model: 'snapshot-v1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] };
        server = http.createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), authorization: req.headers.authorization });
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        connection = { modelId: model.id, revision: 1, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
            requestDimensions: false, apiKey: 'fixture-key', options: remoteModelOptions({ responseModel: 'snapshot-v1' }) };
    });
    afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const messages = [{ role: 'user', content: 'Привет' }];
    it('Отправляет alias, принимает только настроенное имя ответа и сохраняет внутреннюю идентичность', async () => {
        const result = await new RemoteModelClient().infer(model, connection, 'chat', { messages });
        expect(result).toMatchObject({ model: model.model, message: { content: 'OK' }, done: true });
        expect(received).toEqual([{ url: '/v1/chat/completions', authorization: 'Bearer fixture-key', body: { model: model.model, messages, stream: false } }]);
        answer.model = 'snapshot-v2';
        await expect(new RemoteModelClient().infer(model, connection, 'chat', { messages })).rejects.toMatchObject({ kind: 'response' });
        expect(received).toHaveLength(2);
    });
    it('Без настройки имени по-прежнему отклоняет чужую модель без повторного запроса', async () => {
        await expect(new RemoteModelClient().infer(model, { ...connection, options: {} }, 'chat', { messages })).rejects.toMatchObject({ kind: 'response' });
        expect(received).toHaveLength(1);
    });
    it('Сопоставляет embedding alias с точным ответом до проверки индексов и размерности', async () => {
        answer = { object: 'list', model: 'snapshot-v1', data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }] };
        const embedding = { ...model, capability: 'embedding' as const, dimension: 3 };
        expect(await new RemoteModelClient().infer(embedding, connection, 'embed', { input: ['текст'] })).toMatchObject({ model: model.model, embeddings: [[1, 2, 3]] });
        expect(received[0].body).toEqual({ model: model.model, input: ['текст'], encoding_format: 'float' });
    });
    it.each(['max_tokens', 'max_completion_tokens'] as const)('Отправляет только выбранный %s, не меняя бюджет запроса', async tokenLimitParameter => {
        connection.options = remoteModelOptions({ responseModel: 'snapshot-v1', tokenLimitParameter, maxOutputTokens: 4096 });
        await new RemoteModelClient().infer(model, connection, 'chat', { messages });
        await new RemoteModelClient().infer(model, connection, 'chat', { messages, options: { num_predict: 32 } });
        expect(received.map(entry => entry.body)).toEqual([4096, 32].map(limit => ({ model: model.model, messages, stream: false, [tokenLimitParameter]: limit })));
    });
    it('Отдельный inference не подменяет администраторскую совместимость', async () => {
        connection.options = remoteModelOptions({ responseModel: 'snapshot-v1', tokenLimitParameter: 'max_completion_tokens' });
        await new RemoteModelClient().infer(model, connection, 'chat', { messages, options: { num_predict: 32, responseModel: 'untrusted', tokenLimitParameter: 'max_tokens' } });
        expect(received[0].body).toEqual({ model: model.model, messages, stream: false, max_completion_tokens: 32 });
        expect(received).toHaveLength(1);
    });
});
