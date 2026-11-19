import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RemoteModelClient } from '../remote-model-client';
import { RemoteModelError } from '../remote-model-error';

const KEY = 'sk-very-secret-upstream-key-1234567890';
const model = {
    id: 'model-1ee50491-0e50-4484-aaeb-85321ffbd1db',
    name: 'qwen3-embedding-4b',
    runtime: 'remote-openai',
    capability: 'embedding',
    model: 'qwen3-embedding-4b',
    modelVersion: 'v1',
    dimension: 2560,
    revision: 5,
} as const;
const connection = {
    modelId: model.id,
    revision: 5,
    baseUrl: 'http://api.example.test/v1',
    requestDimensions: true,
    options: {},
    timeoutMs: 90000,
    apiKey: KEY,
};

function makeClient(fetch: typeof globalThis.fetch): RemoteModelClient {
    return new RemoteModelClient({ fetch });
}

/** Response with a JSON body; the body deliberately embeds the API key to prove redaction. */
function upstream(status: number, body?: unknown): Response {
    const text =
        body === undefined
            ? JSON.stringify({ error: { message: `upstream refuses (key=${KEY})` }, code: status })
            : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('RemoteModelClient upstream-error visibility (res-obs/16)', () => {
    it('reads the upstream 400 body, logs model id + route + status + redacted body, classifies rejected', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const fetch = vi.fn(async () =>
            upstream(400, {
                error: {
                    message:
                        'Model "qwen3-embedding-4b" does not support matryoshka representation, changing output dimensions will lead to poor results.',
                    type: 'BadRequestError',
                    code: 400,
                },
            }),
        );
        const client = new RemoteModelClient({ fetch });
        await expect(
            client.infer(model as never, connection as never, 'embed', { input: ['probe'], truncate: false }),
        ).rejects.toMatchObject({ kind: 'rejected', status: 400 });

        expect(warn).toHaveBeenCalledTimes(1);
        const entry = warn.mock.calls[0][0] as string;
        expect(entry).toContain(model.id);
        expect(entry).toContain('/embeddings');
        expect(entry).toContain('400');
        expect(entry).toContain('does not support matryoshka representation');
        // AD-19/AD-O8: the upstream body that reaches the log must not contain credentials.
        expect(entry).not.toContain(KEY);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('redacts a credential echoed by the upstream body', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const client = makeClient(vi.fn(async () => upstream(400)));
        await expect(
            client.infer(model as never, connection as never, 'embed', { input: ['probe'], truncate: false }),
        ).rejects.toMatchObject({ kind: 'rejected', status: 400 });
        const entry = warn.mock.calls[0][0] as string;
        expect(entry).not.toContain(KEY);
        expect(entry).toContain('[REDACTED]');
    });

    it('carries the safe fixed device-facing wording with the upstream code', async () => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const client = makeClient(vi.fn(async () => upstream(400)));
        let message = '';
        try {
            await client.infer(model as never, connection as never, 'embed', { input: ['probe'], truncate: false });
        } catch (error) {
            message = (error as RemoteModelError).message;
        }
        expect(message).toContain('HTTP 400');
        expect(message).toContain('Проверьте настройки подключения модели');
        expect(message).not.toContain(KEY);
        expect(message).not.toContain('upstream refuses');
    });

    it('401 keeps the prior authorization classification', async () => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        await expect(
            makeClient(vi.fn(async () => upstream(401))).infer(model as never, connection as never, 'embed', {
                input: ['probe'],
                truncate: false,
            }),
        ).rejects.toMatchObject({ kind: 'authorization', status: 401 });
    });

    it('403 keeps the prior authorization classification', async () => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        await expect(
            makeClient(vi.fn(async () => upstream(403))).infer(model as never, connection as never, 'embed', {
                input: ['probe'],
                truncate: false,
            }),
        ).rejects.toMatchObject({ kind: 'authorization', status: 403 });
    });

    it('429 keeps the prior rate-limit classification', async () => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        await expect(
            makeClient(vi.fn(async () => upstream(429))).infer(model as never, connection as never, 'embed', {
                input: ['probe'],
                truncate: false,
            }),
        ).rejects.toMatchObject({ kind: 'rate-limit', status: 429 });
    });

    it('a 5xx refusal is still unavailable and marked as provider outage', async () => {
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        await expect(
            makeClient(vi.fn(async () => upstream(503))).infer(model as never, connection as never, 'embed', {
                input: ['probe'],
                truncate: false,
            }),
        ).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
    });
});
