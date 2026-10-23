import {beforeEach, describe, expect, it, vi} from 'vitest';
import {modelRateApi} from '../src/features/ModelRateLimits/api';
const api = vi.hoisted(() => ({get: vi.fn(), put: vi.fn()}));
vi.mock('../src/core/api/base', () => ({default: api}));
const value = {modelId: 'm /x', revision: 0, requests: 5, windowMs: 5000, enabled: true, featureEnabled: true, updatedBy: null, updatedAt: null, canManage: true};
beforeEach(() => {vi.resetAllMocks(); api.get.mockResolvedValue({data: value}); api.put.mockResolvedValue({data: {...value, revision: 1}});});
describe('Model rate policy API', () => {
    it('encodes model identity, forwards project read ACL and cancellation without a write', async () => {
        const abort = new AbortController(); expect(await modelRateApi.read('m /x', 'project-a', abort.signal)).toEqual(value);
        expect(api.get).toHaveBeenCalledWith('/api/models/m%20%2Fx/rate-limit', {signal: abort.signal, timeout: 10000, params: {projectId: 'project-a'}}); expect(api.put).not.toHaveBeenCalled();
    });
    it('sends only the independent CAS fields and allows a global read without project params', async () => {
        const signal = new AbortController().signal, input = {expectedRevision: 0, requests: 8, windowMs: 5000, enabled: false}; await modelRateApi.write('m /x', input, signal); await modelRateApi.read('m /x', undefined, signal);
        expect(api.put).toHaveBeenCalledWith('/api/models/m%20%2Fx/rate-limit', input, {signal, timeout: 10000}); expect(api.get.mock.calls[0][1]).not.toHaveProperty('params');
    });
    it.each([{modelId: 'other'}, {revision: -1}, {requests: 0}, {requests: 1.5}, {windowMs: 999}, {windowMs: 86400001}, {enabled: 'true'}, {featureEnabled: undefined}, {canManage: undefined}, {updatedAt: 'bad'}, {updatedBy: 1}])('rejects malformed or wrong-model receipt %j', async patch => {api.get.mockResolvedValueOnce({data: {...value, ...patch}}); await expect(modelRateApi.read(value.modelId, undefined, new AbortController().signal)).rejects.toThrow('некорректные');});
});
