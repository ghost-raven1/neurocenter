vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteConnectionService } from '../src/models/remote-connection.service';
import { RemoteModelClient } from '../src/models/remote-model-client';
import type { ModelsService } from '../src/models/models.service';
import type { IModel } from '../src/models/model.types';
import type { IRemoteConnectionRow } from '../src/models/remote-connection.repository';

vi.mock('../src/models/model-events', () => ({ notifyModelCatalogChange: vi.fn(async () => undefined) }));
const model: IModel = { id: 'remote', name: 'Remote', description: '', runtime: 'remote-openai', capability: 'chat', model: 'fixture', modelVersion: '2026-10',
    dimension: null, source: 'custom', manifestSha256: null, verificationSha256: null, revision: 1, createdAt: '', updatedAt: '' };
const row: IRemoteConnectionRow = { model_id: model.id, revision: 1, base_url: 'http://127.0.0.1:1/v1', request_dimensions: false, credential_kind: 'none',
    credential: null, credential_env: null, options: {}, timeout_ms: 90000, semantic_sha: null, verified_at: null, failure_message: null, revoked_at: null };
afterEach(() => vi.restoreAllMocks());
describe('Remote connection check uses configured semantics', () => {
    it.each([undefined, 32, 8192])('Does not force temperature and bounds only the probe output for maxOutputTokens=%s', async maxOutputTokens => {
        const service = new RemoteConnectionService({ pool: {} } as ModelsService);
        const options = maxOutputTokens === undefined ? {} : { maxOutputTokens, temperature: 0.7, topP: 0.8 };
        vi.spyOn(service.repository, 'head').mockResolvedValue({ ...row, options });
        vi.spyOn(service.repository, 'verify').mockResolvedValue(model);
        const infer = vi.spyOn(RemoteModelClient.prototype, 'infer').mockResolvedValue({ model: model.model, done: true, done_reason: 'stop', message: { content: 'OK' } });
        await service.check(model, 'fixture', async () => undefined);
        expect(infer).toHaveBeenCalledWith(model, expect.objectContaining({ options }), 'chat', {
            messages: [{ role: 'user', content: 'Reply with the word OK.' }], options: { num_predict: Math.min(maxOutputTokens ?? 64, 64) },
        }, undefined);
        expect((infer.mock.calls[0][3].options as Record<string, unknown>)).not.toHaveProperty('temperature');
        expect(service.repository.verify).toHaveBeenCalledWith(model, 1, expect.stringMatching(/^[a-f0-9]{64}$/), null, 'fixture', expect.any(Function));
    });
});
