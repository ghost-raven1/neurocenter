import {describe, expect, it, vi} from 'vitest';
import {createModelRateController} from '../src/features/ModelRateLimits/controller';
import {initialModelRateState, rateDescription, rateInput} from '../src/features/ModelRateLimits/model';
import type {ModelRateLimit, ModelRateState} from '../src/features/ModelRateLimits/types';

const policy = (patch: Partial<ModelRateLimit> = {}): ModelRateLimit => ({modelId: 'model-a', revision: 0, requests: 5, windowMs: 5000, enabled: true, updatedAt: null, updatedBy: null, canManage: true, featureEnabled: true, ...patch});
const deferred = <T>() => {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;}); return {promise, resolve, reject};};
const failure = (status: number) => ({isAxiosError: true, response: {status, data: {message: 'Ошибка ' + status}}});
function setup(initial = policy()) {
    let state: ModelRateState = initialModelRateState(), owner = true;
    const read = vi.fn().mockResolvedValue(initial), write = vi.fn().mockResolvedValue(policy({revision: 1, requests: 8}));
    const controller = createModelRateController({read, write, captureOwner: () => () => owner, onChange: value => {state = value;}}); controller.activate();
    return {controller, read, write, state: () => state, revoke: () => {owner = false;}};
}

describe('Independent per-model settings', () => {
    it('reads defaults without writing and saves seconds as milliseconds on its own revision', async () => {
        const f = setup(); await f.controller.refresh(); expect(f.write).not.toHaveBeenCalled(); expect(f.state().draft).toEqual({requests: 5, seconds: 5, enabled: true});
        f.controller.edit('requests', 8); f.controller.edit('seconds', 2.125); f.write.mockResolvedValueOnce(policy({revision: 1, requests: 8, windowMs: 2125})); await f.controller.save();
        expect(f.write).toHaveBeenCalledWith({expectedRevision: 0, requests: 8, windowMs: 2125, enabled: true}, expect.any(AbortSignal)); expect(f.state().pending).toBeUndefined(); expect(f.state().notice).toBe('Лимит сохранён.');
    });
    it('allows preparing a policy while global enforcement is off, including per-model unlimited', async () => {
        const f = setup(policy({featureEnabled: false})); await f.controller.refresh(); f.controller.edit('enabled', false); f.write.mockResolvedValueOnce(policy({revision: 1, featureEnabled: false, enabled: false})); await f.controller.save();
        expect(f.write.mock.calls[0][0].enabled).toBe(false); expect(rateDescription(f.state().policy!)).toBe('Без ограничения запросов');
    });
    it('read-only users cannot save; malformed draft remains visible without a request', async () => {
        const readonly = setup(policy({canManage: false})); await readonly.controller.refresh(); await readonly.controller.save(); expect(readonly.write).not.toHaveBeenCalled();
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', null); await f.controller.save(); expect(f.state().draft.requests).toBeNull(); expect(f.state().error).toContain('от 1 до 1000'); expect(f.write).not.toHaveBeenCalled();
    });
    it('after a lost write acknowledgement confirms the desired authoritative state using GET only', async () => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8);
        f.write.mockRejectedValueOnce(new Error('Connection reset')); f.read.mockResolvedValueOnce(policy({revision: 1, requests: 8})); await f.controller.save();
        expect(f.write).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledTimes(2); expect(f.state().pending).toBeUndefined(); expect(f.state().notice).toContain('подтверждены'); expect(f.state().draft.requests).toBe(8);
    });
    it('unknown uncommitted write freezes its exact intent and repeats only after explicit save', async () => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8); f.write.mockRejectedValueOnce(new Error('Lost ACK')); await f.controller.save();
        expect(f.state().pending).toEqual({expectedRevision: 0, requests: 8, windowMs: 5000, enabled: true}); f.controller.edit('requests', 99); expect(f.state().draft.requests).toBe(8); expect(f.write).toHaveBeenCalledOnce();
        await f.controller.save(); expect(f.write).toHaveBeenCalledTimes(2); expect(f.write.mock.calls[1][0]).toEqual(f.write.mock.calls[0][0]); expect(f.state().pending).toBeUndefined();
    });
    it('a CAS conflict retains input until explicit compare choice, then saves on the chosen fresh revision', async () => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8); f.write.mockRejectedValueOnce(failure(409)); f.read.mockResolvedValueOnce(policy({revision: 2, requests: 15})); await f.controller.save();
        expect(f.state().draft.requests).toBe(8); expect(f.state().conflict?.requests).toBe(15); expect(f.state().baseRevision).toBe(0); await f.controller.save(); expect(f.write).toHaveBeenCalledOnce();
        f.controller.keepDraft(); f.write.mockResolvedValueOnce(policy({revision: 3, requests: 8})); await f.controller.save(); expect(f.write.mock.calls[1][0].expectedRevision).toBe(2);
    });
    it('the other conflict choice adopts server settings instead of discarding them silently', async () => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8); f.read.mockResolvedValueOnce(policy({revision: 2, requests: 15})); await f.controller.refresh();
        expect(f.state().draft.requests).toBe(8); f.controller.useCurrent(); expect(f.state().draft.requests).toBe(15); expect(f.state().baseRevision).toBe(2); expect(f.state().conflict).toBeUndefined(); expect(f.write).not.toHaveBeenCalled();
    });
    it('a definite validation rejection keeps the editable draft and never rebases it', async () => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8); f.write.mockRejectedValueOnce(failure(422)); await f.controller.save();
        expect(f.state().pending).toBeUndefined(); expect(f.state().baseRevision).toBe(0); f.controller.edit('requests', 9); expect(f.state().draft.requests).toBe(9); expect(f.read).toHaveBeenCalledOnce();
    });
    it.each([401, 403, 404])('fresh denied %s hides settings and permission, preserving only the local draft', async status => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8); f.read.mockRejectedValueOnce(failure(status)); await f.controller.refresh(); expect(f.state().policy).toBeUndefined(); expect(f.state().draft.requests).toBe(8); await f.controller.save(); expect(f.write).not.toHaveBeenCalled();
    });
    it('access recovery does not silently discard the local draft or rebase a rejected save', async () => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8); f.write.mockRejectedValueOnce(failure(403)); await f.controller.save();
        expect(f.state().policy).toBeUndefined(); f.read.mockResolvedValueOnce(policy({revision: 2, requests: 15})); await f.controller.refresh();
        expect(f.state().draft.requests).toBe(8); expect(f.state().conflict?.requests).toBe(15); expect(f.state().baseRevision).toBeUndefined(); await f.controller.save(); expect(f.write).toHaveBeenCalledOnce();
        f.controller.keepDraft(); f.write.mockResolvedValueOnce(policy({revision: 3, requests: 8})); await f.controller.save(); expect(f.write.mock.calls[1][0].expectedRevision).toBe(2);
    });
    it('an older refresh cannot overwrite a saved policy or settle another owner', async () => {
        const f = setup(); await f.controller.refresh(); const old = deferred<ModelRateLimit>(); f.read.mockReturnValueOnce(old.promise); const pending = f.controller.refresh();
        // Finish the read, then hold an independent write while the owner changes.
        old.resolve(policy({revision: 1})); await pending; f.controller.edit('requests', 8); const ack = deferred<ModelRateLimit>(); f.write.mockReturnValueOnce(ack.promise); const saving = f.controller.save(); f.revoke(); ack.resolve(policy({revision: 2, requests: 8})); await saving;
        expect(f.state().policy?.revision).toBe(1); expect(f.state().notice).toBe('');
    });
    it('overlapping reads and disposal ignore stale replies and abort owned transports', async () => {
        const f = setup(), old = deferred<ModelRateLimit>(), fresh = deferred<ModelRateLimit>(); f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        const a = f.controller.refresh(), b = f.controller.refresh(); expect(f.read.mock.calls[0][0].aborted).toBe(true); fresh.resolve(policy({revision: 3, requests: 9})); await b; old.resolve(policy()); await a; expect(f.state().policy?.revision).toBe(3);
        const late = deferred<ModelRateLimit>(); f.read.mockReturnValueOnce(late.promise); const closing = f.controller.refresh(); f.controller.dispose(); expect(f.read.mock.calls[2][0].aborted).toBe(true); late.resolve(policy({revision: 99})); await closing; expect(f.state().policy?.revision).toBe(3);
    });
    it('deduplicates double save while a transport is pending and preserves unknown state if reconciliation fails', async () => {
        const f = setup(); await f.controller.refresh(); f.controller.edit('requests', 8); const write = deferred<ModelRateLimit>(); f.write.mockReturnValueOnce(write.promise); const first = f.controller.save(); await f.controller.save(); expect(f.write).toHaveBeenCalledOnce();
        f.read.mockRejectedValueOnce(new Error('Still offline')); write.reject(new Error('Unknown ACK')); await first; expect(f.state().pending?.requests).toBe(8); expect(f.state().error).toBe('Still offline'); expect(f.state().saving).toBe(false);
    });
});
describe('Policy draft validation', () => {
    it.each([null, 0, 1001, 1.5, NaN])('rejects requests %s', requests => {expect(() => rateInput({requests, seconds: 5, enabled: true}, 0)).toThrow('целое');});
    it.each([null, 0.999, 86400.001, Infinity, NaN, 1.0001])('rejects seconds %s', seconds => {expect(() => rateInput({requests: 5, seconds, enabled: true}, 0)).toThrow('период');});
    it('accepts boundaries and describes the real saved value', () => {expect(rateInput({requests: 1000, seconds: 86400, enabled: false}, 3)).toEqual({expectedRevision: 3, requests: 1000, windowMs: 86400000, enabled: false}); expect(rateDescription(policy())).toBe('5 запросов за 5 с');});
});
