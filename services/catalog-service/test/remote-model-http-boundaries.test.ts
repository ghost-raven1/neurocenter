import http from 'node:http';
import { appendFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteModelClient } from '../src/models/remote-model-client';
import type { IModel } from '../src/models/model.types';
import type { IRemoteModelConnection } from '../src/models/remote-model.types';

const model: IModel = { id: 'wire-boundary-model', name: 'HTTP fixture', description: '', runtime: 'remote-openai', model: 'wire-model', modelVersion: 'fixture-v1',
    capability: 'chat', manifestSha256: null, verificationSha256: null, dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const messages = [{ role: 'user', content: 'Привет' }];
const chat = (message: Record<string, unknown> = { role: 'assistant', content: 'Ответ' }, finish: unknown = 'stop') => ({ model: model.model,
    choices: [{ index: 0, finish_reason: finish, message }] });
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

describe('OpenAI HTTP boundaries beyond a complete JSON response', () => {
    let server: http.Server, connection: IRemoteModelConnection;
    let handler: (request: http.IncomingMessage, response: http.ServerResponse) => void;
    let received: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }>;
    let sockets: Set<Socket>, timers: Array<ReturnType<typeof setTimeout>>, responseClosed: Promise<void>, markClosed: () => void;
    let port: number;
    beforeEach(async () => {
        received = []; sockets = new Set(); timers = [];
        responseClosed = new Promise(resolve => { markClosed = resolve; });
        handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(chat())); };
        server = http.createServer(async (request, response) => {
            response.once('close', () => markClosed());
            const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
            handler(request, response);
        });
        server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as { port: number }).port;
        connection = { modelId: model.id, revision: 1, baseUrl: `http://127.0.0.1:${port}/compatible/v1`, requestDimensions: false, apiKey: 'fixture-wire-secret' };
    });
    afterEach(async () => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        for (let attempt = 0; sockets.size && attempt < 20; attempt++) await wait(5);
        expect(server.listening).toBe(false); expect(sockets.size).toBe(0);
        if (process.env.REMOTE_WIRE_AUDIT_CLEANUP_FILE) await appendFile(process.env.REMOTE_WIRE_AUDIT_CLEANUP_FILE,
            JSON.stringify({ port, listening: server.listening, sockets: sockets.size }) + '\n', { mode: 0o600 });
    });
    const infer = (client = new RemoteModelClient(), signal?: AbortSignal) => client.infer(model, connection, 'chat', { messages }, signal);

    it('Decodes fragmented UTF-8 and exposes only visible content while preserving the real token counters', async () => {
        handler = (_request, response) => {
            const bytes = Buffer.from(JSON.stringify({ ...chat({ role: 'assistant', content: '答え 🌸', reasoning_content: 'private reasoning fixture' }),
                usage: { prompt_tokens: 3, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 6 } } }));
            const split = bytes.indexOf(Buffer.from('🌸')) + 2;
            response.writeHead(200, { 'content-type': 'application/json' }); response.write(bytes.subarray(0, split));
            timers.push(setTimeout(() => response.end(bytes.subarray(split)), 10));
        };
        expect(await infer()).toEqual({ model: model.model, done: true, done_reason: 'stop', message: { role: 'assistant', content: '答え 🌸' },
            prompt_eval_count: 3, eval_count: 7, usage_reported: true });
        expect(received).toEqual([{ url: '/compatible/v1/chat/completions', authorization: 'Bearer fixture-wire-secret', body: { model: model.model, messages, stream: false } }]);
    });
    it('Embeds a single string through the same base path without inventing Authorization or dimensions', async () => {
        handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ object: 'list', model: model.model,
            data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.5, 1] }], usage: { prompt_tokens: 0 } })); };
        expect(await new RemoteModelClient().infer({ ...model, capability: 'embedding', dimension: 3 }, { ...connection, apiKey: undefined }, 'embed', { input: 'Один текст' }))
            .toEqual({ model: model.model, embeddings: [[0.25, -0.5, 1]], prompt_eval_count: 0, usage_reported: true });
        expect(received).toEqual([{ url: '/compatible/v1/embeddings', authorization: undefined,
            body: { model: model.model, input: ['Один текст'], encoding_format: 'float' } }]);
    });
    it('Applies the response cap to decompressed bytes rather than the short gzip transfer', async () => {
        const compressed = gzipSync(JSON.stringify(chat({ content: 'X'.repeat(8192) })));
        expect(compressed.length).toBeLessThan(512);
        handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length }); response.end(compressed); };
        await expect(infer(new RemoteModelClient({ maximumBytes: 512 }))).rejects.toMatchObject({ kind: 'response', message: 'Ответ удалённой модели превышает допустимый размер.' });
        expect(received).toHaveLength(1);
    });
    it('Cancels a stalled 429 error body immediately without exposing its private content or retrying', async () => {
        handler = (_request, response) => { response.writeHead(429, { 'content-type': 'application/json' }); response.write('{"error":"fixture-wire-secret private-provider-body'); };
        const error = await infer(new RemoteModelClient({ timeoutMs: 1000 })).catch((cause: Error) => cause);
        expect(error).toMatchObject({ kind: 'rate-limit', message: 'Удалённый API ограничил запросы. Повторите позже.' });
        await Promise.race([responseClosed, wait(500).then(() => { throw new Error('429 body was not cancelled'); })]);
        expect(received).toHaveLength(1);
    });
    it('Keeps one total body deadline while the provider trickles progress', async () => {
        let writes = 0;
        handler = (_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); writes++;
            for (let index = 1; index <= 20; index++) timers.push(setTimeout(() => { if (!response.destroyed) { response.write(' '); writes++; } }, index * 20));
        };
        const started = performance.now();
        await expect(infer(new RemoteModelClient({ timeoutMs: 120 }))).rejects.toMatchObject({ kind: 'unavailable', message: 'Удалённая модель не ответила вовремя.' });
        expect(performance.now() - started).toBeLessThan(900); expect(writes).toBeGreaterThan(1); expect(writes).toBeLessThan(21);
        await Promise.race([responseClosed, wait(500).then(() => { throw new Error('timed-out body was not cancelled'); })]);
        expect(received).toHaveLength(1);
    });
    it('Preserves caller cancellation after response headers and closes the actual response without retry', async () => {
        const controller = new AbortController(), reason = new Error('own caller cancellation');
        handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); timers.push(setTimeout(() => controller.abort(reason), 20)); };
        expect(await infer(new RemoteModelClient(), controller.signal).catch((cause: unknown) => cause)).toBe(reason);
        await Promise.race([responseClosed, wait(500).then(() => { throw new Error('caller-aborted body was not cancelled'); })]);
        expect(received).toHaveLength(1);
    });
    it('Sends no request for an already aborted caller', async () => {
        const controller = new AbortController(), reason = new Error('cancelled before inference'); controller.abort(reason);
        expect(await infer(new RemoteModelClient(), controller.signal).catch((cause: unknown) => cause)).toBe(reason);
        expect(received).toHaveLength(0);
    });
    it('Maps a real peer reset to a safe transport error without replaying the inference', async () => {
        handler = (request) => request.socket.destroy(new Error('fixture-wire-secret private-peer-error'));
        await expect(infer()).rejects.toMatchObject({ kind: 'unavailable', message: 'Не удалось соединиться с удалённым API модели.' });
        expect(received).toHaveLength(1);
    });
    it('Does not promote non-visible reasoning into a user answer', async () => {
        handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(chat({ content: '', reasoning_content: 'hidden reasoning fixture' }))); };
        await expect(infer()).rejects.toMatchObject({ kind: 'response', message: 'Удалённая модель не завершила ответ.' });
        expect(received).toHaveLength(1);
    });
    it('Rejects structured output where a visible string response was requested', async () => {
        handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(chat({ content: [{ type: 'text', text: 'not the requested schema' }] }))); };
        await expect(infer()).rejects.toMatchObject({ kind: 'response' }); expect(received).toHaveLength(1);
    });
    it.each([{ finish: ['stop'] }, { finish: ['length'] }])('Rejects an array finish_reason instead of accepting its string coercion: $finish', async ({ finish }) => {
        handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(chat({ content: 'visible fixture' }, finish))); };
        await expect(infer()).rejects.toMatchObject({ kind: 'response' }); expect(received).toHaveLength(1);
    });
    it('Rejects an array role before forwarding a malformed paid request', async () => {
        await expect(new RemoteModelClient().infer(model, connection, 'chat', { messages: [{ role: ['user'], content: 'fixture' }] })).rejects.toMatchObject({ kind: 'response' });
        expect(received).toHaveLength(0);
    });
});
