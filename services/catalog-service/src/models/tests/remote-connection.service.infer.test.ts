import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { RemoteConnectionService } from '../remote-connection.service';
import { RemoteModelError } from '../remote-model-error';

const model = {
    id: 'model-1ee50491-0e50-4484-aaeb-85321ffbd1db',
    runtime: 'remote-openai',
    capability: 'embedding',
    model: 'qwen3-embedding-4b',
    modelVersion: 'v1',
    dimension: 2560,
    revision: 5,
    verificationSha256: 'a'.repeat(64),
} as const;
const row = {
    model_id: model.id,
    revision: 5,
    base_url: 'http://api.example.test/v1',
    request_dimensions: true,
    options: {},
    timeout_ms: 90000,
    semantic_sha: 'a'.repeat(64),
    verified_at: null,
    failure_message: null,
    revoked_at: null,
} as const;
const models = { pool: { query: vi.fn(async () => ({ rows: [row] })) } } as never;

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('RemoteConnectionService.infer upstream-code propagation (res-obs/16)', () => {
    it('turns a rejected upstream into a 503 whose message carries the fixed code wording', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            error: {
                                message:
                                    'Model "qwen3-embedding-4b" does not support matryoshka representation.',
                                code: 400,
                            },
                        }),
                        { status: 400, headers: { 'content-type': 'application/json' } },
                    ),
            ),
        );
        const service = new RemoteConnectionService(models, undefined, undefined, { wire: vi.fn() } as never);
        let thrown: unknown;
        try {
            await service.infer(
                model as never,
                'embed',
                { input: ['probe'], truncate: false },
                undefined,
            );
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(ServiceUnavailableException);
        const message = (thrown as ServiceUnavailableException).message;
        expect(message).toContain('HTTP 400');
        expect(message).toContain('Проверьте настройки подключения модели');
        expect(message).not.toContain('does not support matryoshka');
    });

    it('keeps a 401 as a 503 authorization refusal (no code), not a rejected-code error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ message: 'denied' }), { status: 401 })),
        );
        const service = new RemoteConnectionService(models, undefined, undefined, { wire: vi.fn() } as never);
        let thrown: unknown;
        try {
            await service.infer(model as never, 'embed', { input: ['probe'], truncate: false }, undefined);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(ServiceUnavailableException);
        const message = (thrown as ServiceUnavailableException).message;
        // The client classified this as authorization (see client test); the device still gets a safe 503.
        expect(message).toContain('ключ');
        expect(message).not.toContain('HTTP 401');
    });
});
