import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteModelClient } from '../src/models/remote-model-client';
import type { IModel } from '../src/models/model.types';
import type { IRemoteModelConnection } from '../src/models/remote-model.types';

const model: IModel = { id: 'model-remote', name: 'Удалённая', description: '', runtime: 'remote-openai', model: 'fixture-model', modelVersion: '2026-10', capability: 'embedding',
    manifestSha256: null, verificationSha256: null, dimension: 3, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const response = () => ({ object: 'list', model: model.model, data: [0, 1].map(index => ({ object: 'embedding', index, embedding: [index + 1, 2, 3] })), usage: { prompt_tokens: 4 } });

describe('Настоящий HTTP-транспорт удалённой модели', () => {
    let server: http.Server, connection: IRemoteModelConnection;
    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    let received: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }>;
    beforeEach(async () => {
        received = [];
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response())); };
        server = http.createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
            handler(req, res);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        connection = { modelId: model.id, revision: 1, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestDimensions: true, apiKey: 'fixture-secret' };
    });
    afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const infer = (client = new RemoteModelClient()) => client.infer(model, connection, 'embed', { input: ['первый', 'второй'] });

    it('Отправляет exact модель, размерность и Bearer только заданному API, сопоставляя индексы ответа', async () => {
        handler = (_req, res) => { const value = response(); value.data.reverse(); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
        expect(await infer()).toEqual({ model: model.model, embeddings: [[1, 2, 3], [2, 2, 3]], prompt_eval_count: 4 });
        expect(received).toEqual([{ url: '/v1/embeddings', authorization: 'Bearer fixture-secret', body: { model: model.model, input: ['первый', 'второй'], dimensions: 3, encoding_format: 'float' } }]);
    });
    it('Remote Ollama использует /api/embed без скачивания весов или команды pull', async () => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: model.model, embeddings: [[1, 2, 3], [2, 3, 4]], prompt_eval_count: 2 })); };
        expect(await new RemoteModelClient().infer({ ...model, runtime: 'remote-ollama' }, { ...connection, baseUrl: connection.baseUrl.replace('/v1', ''), apiKey: undefined }, 'embed', { input: ['первый', 'второй'] })).toMatchObject({ embeddings: [[1, 2, 3], [2, 3, 4]] });
        expect(received[0]).toMatchObject({ url: '/api/embed', body: { model: model.model, truncate: false, dimensions: 3 } });
        expect(received[0].authorization).toBeUndefined();
    });
    it.each([401, 403, 429, 500])('HTTP %i возвращает безопасную ошибку без тела провайдера и ключа', async status => {
        handler = (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"fixture-secret https://private.example.test"}'); };
        const error = await infer().catch(cause => cause as Error);
        expect(error.message).not.toContain('fixture-secret'); expect(error.message).not.toContain('private.example');
        expect(error.kind).toBe(status === 429 ? 'rate-limit' : status < 500 ? 'authorization' : 'unavailable');
        expect(received).toHaveLength(1);
    });
    it('Редирект не передаёт ключ следующему адресу', async () => {
        handler = (_req, res) => { res.writeHead(307, { location: connection.baseUrl + '/stolen' }); res.end(); };
        await expect(infer()).rejects.toMatchObject({ kind: 'unavailable' }); expect(received).toHaveLength(1);
    });
    it.each(['wrong-model', 'missing-vector', 'duplicate-index', 'out-of-range-index', 'wrong-dimension', 'zero-vector', 'overflow-vector', 'stream', 'invalid-json', 'error-envelope'])('Отказывается принимать %s', async problem => {
        handler = (_req, res) => {
            const value = response();
            if (problem === 'wrong-model') value.model = 'different';
            if (problem === 'missing-vector') value.data.pop();
            if (problem === 'duplicate-index') value.data[1].index = 0;
            if (problem === 'out-of-range-index') value.data[1].index = 2;
            if (problem === 'wrong-dimension') value.data[0].embedding = [1, 2];
            if (problem === 'zero-vector') value.data[0].embedding = [0, 0, 0];
            if (problem === 'overflow-vector') value.data[0].embedding = [1e39, 1, 1];
            res.writeHead(200, { 'content-type': problem === 'stream' ? 'text/event-stream' : 'application/json' });
            res.end(problem === 'invalid-json' ? '{' : problem === 'error-envelope' ? '{"error":"private error"}' : JSON.stringify(value));
        };
        await expect(infer()).rejects.toMatchObject({ kind: 'response' });
    });
    it('Ограничивает размер ответа, не удерживая бесконечное тело', async () => {
        await expect(infer(new RemoteModelClient({ maximumBytes: 64 }))).rejects.toMatchObject({ kind: 'response' });
    });
    it.each(['headers', 'body'])('Дедлайн ограничивает ожидание %s', async stage => {
        handler = (_req, res) => { if (stage === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); } };
        await expect(infer(new RemoteModelClient({ timeoutMs: 50 }))).rejects.toMatchObject({ kind: 'unavailable', message: 'Удалённая модель не ответила вовремя.' });
    });
    it('Отмена вызывающего останавливает сетевой запрос и не повторяет оплачиваемый inference', async () => {
        const abort = new AbortController(); handler = () => { abort.abort(new Error('Пользователь отменил')); };
        await expect(new RemoteModelClient().infer(model, connection, 'embed', { input: ['первый'] }, abort.signal)).rejects.toThrow('Пользователь отменил');
        expect(received).toHaveLength(1);
    });
    it('Chat и vision проходят тем же HTTP adapter с локальной data-картинкой и без streaming', async () => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: model.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } })); };
        const image = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
        const result = await new RemoteModelClient().infer({ ...model, capability: 'vision', dimension: null }, connection, 'chat', { messages: [{ role: 'user', content: 'Опиши', images: [image] }], options: { num_predict: 32, temperature: 0 } });
        expect(result).toMatchObject({ done: true, done_reason: 'stop', message: { role: 'assistant', content: 'OK' } });
        expect(received[0]).toMatchObject({ url: '/v1/chat/completions', body: { stream: false, max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: 'Опиши' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image } }] }] } });
    });
    it('Применяет connection defaults, а явный запрос переопределяет только заданные поля', async () => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: model.model, choices: [{ index: 0, finish_reason: 'stop', message: { content: 'OK' } }] })); };
        const configured = { ...connection, options: { temperature: 0.7, topP: 0.9, maxOutputTokens: 8192 } };
        const chat = { ...model, capability: 'chat' as const, dimension: null }, messages = [{ role: 'user', content: 'Привет' }];
        await new RemoteModelClient().infer(chat, configured, 'chat', { messages });
        await new RemoteModelClient().infer(chat, configured, 'chat', { messages, options: { temperature: 0, top_p: 0.5 } });
        expect(received.map(item => item.body)).toEqual([
            { model: model.model, messages, stream: false, temperature: 0.7, top_p: 0.9, max_tokens: 8192 },
            { model: model.model, messages, stream: false, temperature: 0, top_p: 0.5, max_tokens: 8192 },
        ]);
    });
    it('Не навязывает провайдеру отсутствующие параметры генерации', async () => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: model.model, choices: [{ index: 0, finish_reason: 'stop', message: { content: 'OK' } }] })); };
        const messages = [{ role: 'user', content: 'Привет' }];
        await new RemoteModelClient().infer({ ...model, capability: 'chat', dimension: null }, connection, 'chat', { messages, options: {} });
        expect(received[0].body).toEqual({ model: model.model, messages, stream: false });
    });
    it.each([
        { usage: undefined, input: null, output: null, reported: false },
        { usage: { prompt_tokens: 0, completion_tokens: 0 }, input: 0, output: 0, reported: true },
        { usage: { prompt_tokens: 4 }, input: 4, output: null, reported: true },
        { usage: { prompt_tokens: -1, completion_tokens: '7' }, input: null, output: null, reported: false },
    ])('Сохраняет доступность usage без подмены отсутствующих счётчиков нулями %#', async ({ usage, input, output, reported }) => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: model.model,
            choices: [{ index: 0, finish_reason: 'stop', message: { content: 'OK' } }], ...(usage ? { usage } : {}) })); };
        const result = await new RemoteModelClient().infer({ ...model, capability: 'chat', dimension: null }, connection, 'chat', { messages: [{ role: 'user', content: 'Привет' }] });
        expect(result).toMatchObject({ prompt_eval_count: input, eval_count: output, usage_reported: reported });
    });
    it.each([
        { counts: {}, reported: false },
        { counts: { prompt_eval_count: 0, eval_count: 0 }, reported: true },
        { counts: { eval_count: 7 }, reported: true },
        { counts: { prompt_eval_count: '4', eval_count: -1 }, reported: false },
    ])('Remote Ollama сообщает доступность usage без синтетических нулей %#', async ({ counts, reported }) => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: model.model,
            done: true, done_reason: 'stop', message: { content: 'OK' }, ...counts })); };
        const result = await new RemoteModelClient().infer({ ...model, runtime: 'remote-ollama', capability: 'chat', dimension: null },
            { ...connection, baseUrl: connection.baseUrl.replace('/v1', '') }, 'chat', { messages: [{ role: 'user', content: 'Привет' }] });
        expect(result).toMatchObject({ ...counts, usage_reported: reported });
    });
    it('Маппит Ollama defaults и contextWindow, отказывая OpenAI вместо тихого игнорирования', async () => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: model.model, done: true, done_reason: 'stop', message: { content: 'OK' } })); };
        const messages = [{ role: 'user', content: 'Привет' }], configured = { ...connection, options: { temperature: 0.2, topP: 0.8, maxOutputTokens: 4096, contextWindow: 65536 } };
        await new RemoteModelClient().infer({ ...model, capability: 'chat', runtime: 'remote-ollama', dimension: null }, configured, 'chat', { messages, options: { num_predict: 99 } });
        expect(received[0].body).toEqual({ model: model.model, messages, stream: false, think: false, options: { temperature: 0.2, top_p: 0.8, num_predict: 99, num_ctx: 65536 } });
        await expect(new RemoteModelClient().infer({ ...model, capability: 'chat', dimension: null }, configured, 'chat', { messages })).rejects.toThrow('Ollama');
        await expect(new RemoteModelClient().infer(model, { ...connection, options: { temperature: 0.5 } }, 'embed', { input: ['Текст'] })).rejects.toThrow('Embedding');
        expect(received).toHaveLength(1);
    });
    it('Применяет сохранённый timeout ко всему ответу, включая тело', async () => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); };
        await expect(new RemoteModelClient().infer(model, { ...connection, timeoutMs: 1000 }, 'embed', { input: ['Текст'] })).rejects.toMatchObject({ kind: 'unavailable', message: 'Удалённая модель не ответила вовремя.' });
        expect(received).toHaveLength(1);
    });
    it.each(['tool_calls', 'incomplete', 'empty', 'wrong-model'])('Chat отклоняет %s без неявного fallback', async problem => {
        handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: problem === 'wrong-model' ? 'wrong' : model.model,
            choices: [{ index: 0, finish_reason: problem === 'tool_calls' ? 'tool_calls' : problem === 'incomplete' ? null : 'stop', message: { content: problem === 'empty' ? '' : 'OK' } }] })); };
        await expect(new RemoteModelClient().infer({ ...model, capability: 'chat', dimension: null }, connection, 'chat', { messages: [{ role: 'user', content: 'Привет' }] })).rejects.toMatchObject({ kind: 'response' });
        expect(received).toHaveLength(1);
    });
});
