import {anonymousProviderAccess} from './remote-provider.fixture';
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { readFeatures } from '../../shared/feature-client.cjs';
import { ModelRuntime } from '../src/models/model-runtime';
import { OllamaClient } from '../src/models/ollama-client';
import { localModelAlias } from '../src/models/local-model-alias';
import { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { IRemoteConnectionRow } from '../src/models/remote-connection.repository';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import { ModelRateLimitsService } from '../src/model-rate-limits/model-rate-limits.service';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import { isModelProviderUnavailable } from '../src/models/model-provider-availability';
import { embeddingModel, jsonResponse, projectContextPort } from './helpers/project-context-port';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeatureEnabled: vi.fn(async () => undefined), requireFeaturesEnabled: vi.fn(async () => undefined) }));
vi.mock('../../shared/feature-client.cjs', async original => ({ ...await original<typeof import('../../shared/feature-client.cjs')>(), readFeatures: vi.fn() }));
vi.mock('../src/database/pool', () => ({ createPool: () => ({
    query: vi.fn(async () => { throw new Error('controlled ledger failure'); }),
    connect: vi.fn(async () => { throw new Error('controlled checkout failure'); }), end: vi.fn(async () => undefined),
}) }));
beforeEach(() => { vi.mocked(readFeatures).mockResolvedValue(evaluateFeatureFlags(defaultFeatureFlags()) as never); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const alias = localModelAlias(embeddingModel);
const tags = () => jsonResponse({ models: [{ name: alias, digest: embeddingModel.manifestSha256 }] });
const truncated = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('controlled truncated body')); } }), { headers: { 'content-type': 'application/json' } });

describe('Actual model transports classify optional RAG outages', () => {
    it.each(['network', 502, 503, 504] as const)('A local embedding %s outage lets the ordinary question continue', async mode => {
        const request = vi.fn(async (input: string | URL | Request) => {
            if (String(input).endsWith('/api/tags')) return tags();
            if (mode === 'network') throw new TypeError('private upstream address');
            return new Response('<html>private upstream error</html>', { status: mode });
        });
        const f = projectContextPort(models => new ModelRuntime(new OllamaClient({ fetch: request, env: { NODE_ENV: 'test' } }), new RemoteConnectionService(models,undefined,undefined,anonymousProviderAccess)));
        const prepared = await f.prepare();
        expect(prepared.evidence).toMatchObject({ status: 'unavailable', sources: [] });
        expect(prepared.messages[0].content).not.toContain('private upstream');
        expect(f.context.client.call).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
    });
    it.each([
        ['malformed JSON', () => new Response('{')], ['oversized response', () => new Response(new Uint8Array(16 * 1024 ** 2 + 1))],
        ['truncated response', truncated], ['wrong model', () => jsonResponse({ model: 'another', embeddings: [[1, 2, 3]] })],
        ['invalid vectors', () => jsonResponse({ model: alias, embeddings: [[0, 0, 0]] })],
        ['unknown upstream 500', () => new Response('error', { status: 500 })], ['authorization 403', () => new Response('denied', { status: 403 })],
    ] as const)('A local embedding %s remains fatal and is never labelled an outage', async (_name, response) => {
        const request = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/tags') ? tags() : response());
        const f = projectContextPort(models => new ModelRuntime(new OllamaClient({ fetch: request, env: { NODE_ENV: 'test' } }), new RemoteConnectionService(models,undefined,undefined,anonymousProviderAccess)));
        const error = await f.prepare().catch(error => error);
        expect(error).toBeInstanceOf(Error); expect(isModelProviderUnavailable(error)).toBe(false);
        expect(f.context.client.call).not.toHaveBeenCalled();
    });
    it('An invalid local runtime configuration is not a network outage', async () => {
        const request = vi.fn();
        const f = projectContextPort(models => new ModelRuntime(new OllamaClient({ fetch: request, env: { MODEL_RUNTIME_URL: 'not-a-url' } }), new RemoteConnectionService(models,undefined,undefined,anonymousProviderAccess)));
        await expect(f.prepare()).rejects.toMatchObject({ status: 503 }); expect(request).not.toHaveBeenCalled();
    });
    it('Cancellation during a local fetch remains cancellation', async () => {
        let cancel!: () => void;
        const request = vi.fn(async (input: string | URL | Request) => { if (String(input).endsWith('/api/tags')) return tags(); cancel(); throw new TypeError('aborted fetch'); });
        const f = projectContextPort(models => new ModelRuntime(new OllamaClient({ fetch: request, env: { NODE_ENV: 'test' } }), new RemoteConnectionService(models,undefined,undefined,anonymousProviderAccess)));
        cancel = () => f.abort.abort(); await expect(f.prepare()).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.context.client.call).not.toHaveBeenCalled();
    });
});

describe('Real admission owners fail closed before provider dispatch', () => {
    it('An actual usage reservation failure cannot be swallowed as optional embedding unavailability', async () => {
        const request = vi.fn(); let usage!: ModelUsageService;
        const f = projectContextPort(models => { usage = new ModelUsageService(models); return new ModelRuntime(new OllamaClient({ fetch: request }), new RemoteConnectionService(models,undefined,undefined,anonymousProviderAccess), usage); });
        try {
            const error = await f.prepare().catch(error => error);
            expect(error).toBeInstanceOf(ServiceUnavailableException); expect(isModelProviderUnavailable(error)).toBe(false);
            expect(usage.pool.query).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled(); expect(f.context.client.call).not.toHaveBeenCalled();
        } finally { await usage.onApplicationShutdown(); }
    });
    it('An actual rate-store checkout failure cannot be swallowed as optional embedding unavailability', async () => {
        const paths: string[] = []; let limits!: ModelRateLimitsService;
        const request = vi.fn(async (input: string | URL | Request) => { paths.push(new URL(String(input)).pathname); return tags(); });
        const f = projectContextPort(models => {
            limits = new ModelRateLimitsService(models);
            return new ModelRuntime(new OllamaClient({ fetch: request, env: { NODE_ENV: 'test' }, admission: new ModelApiAdmission(limits) }), new RemoteConnectionService(models,undefined,undefined,anonymousProviderAccess));
        });
        try {
            const error = await f.prepare().catch(error => error);
            expect(error).toMatchObject({ status: 503, response: { code: 'MODEL_RATE_STORE_UNAVAILABLE' } });
            expect(isModelProviderUnavailable(error)).toBe(false); expect(paths).toEqual(['/api/tags']);
            expect(limits.pool.connect).toHaveBeenCalledOnce(); expect(f.context.client.call).not.toHaveBeenCalled();
        } finally { await limits.onApplicationShutdown(); }
    });
});

describe('Remote provider wrappers preserve the genuine outage classification only', () => {
    const model = { ...embeddingModel, runtime: 'remote-openai' as const, model: 'remote-embedding', modelVersion: '1', manifestSha256: null, verificationSha256: 'e'.repeat(64) };
    const row: IRemoteConnectionRow = { model_id: model.id, revision: 1, base_url: 'https://provider.example.test/v1', request_dimensions: false, credential_kind: 'none',
        credential: null, credential_env: null, options: {}, timeout_ms: 90000, semantic_sha: model.verificationSha256, verified_at: null, failure_message: null, revoked_at: null };
    const fixture = (response: () => Response | Promise<Response>, connection = row) => {
        vi.stubGlobal('fetch', vi.fn(response));
        return projectContextPort(models => {
            const remote = new RemoteConnectionService(models,undefined,undefined,anonymousProviderAccess);
            vi.spyOn(remote.repository, 'pinned').mockResolvedValue(connection); vi.spyOn(remote.repository, 'failure').mockResolvedValue(undefined);
            return new ModelRuntime(new OllamaClient(), remote);
        }, model);
    };
    it.each(['network', 502, 503, 504] as const)('A real remote %s outage remains available to the context fallback after its HTTP503 wrapper', async mode => {
        const f = fixture(() => mode === 'network' ? Promise.reject(new TypeError('network unavailable')) : new Response('<html>proxy error</html>', { status: mode }));
        expect((await f.prepare()).evidence).toMatchObject({ status: 'unavailable', sources: [] }); expect(f.context.client.call).not.toHaveBeenCalled();
    });
    it.each([
        ['malformed JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
        ['truncated response', truncated], ['oversized response', () => new Response(new Uint8Array(16 * 1024 ** 2 + 1), { headers: { 'content-type': 'application/json' } })],
        ['invalid vectors', () => jsonResponse({ model: model.model, object: 'list', data: [] })],
        ['unknown upstream 500', () => new Response('internal error', { status: 500 })],
        ['authorization 401', () => new Response('denied', { status: 401 })], ['authorization 403', () => new Response('denied', { status: 403 })],
    ] as const)('A real remote %s wrapper stays fatal with its existing HTTP503 status', async (_name, response) => {
        const f = fixture(response), error = await f.prepare().catch(error => error);
        expect(error).toBeInstanceOf(ServiceUnavailableException); expect(error.getStatus()).toBe(503);
        expect(isModelProviderUnavailable(error)).toBe(false); expect(f.context.client.call).not.toHaveBeenCalled();
    });
    it('An invalid remote URL stays a configuration refusal before fetch', async () => {
        const f = fixture(() => jsonResponse({}), { ...row, base_url: 'not-a-url' });
        await expect(f.prepare()).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
    });
    it('A cancelled remote fetch cannot become an availability fallback', async () => {
        const f = fixture(() => { f.abort.abort(); return Promise.reject(new TypeError('aborted fetch')); });
        await expect(f.prepare()).rejects.toMatchObject({ name: 'AbortError' }); expect(f.context.client.call).not.toHaveBeenCalled();
    });
});
