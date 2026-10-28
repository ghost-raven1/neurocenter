import {afterEach, describe, expect, it, vi} from 'vitest';
import {quotaStorageKey} from '../src/features/ModelTokenQuotas/storage';
import type {QuotaReceipt, QuotaView} from '../src/features/ModelTokenQuotas/types';
import {deferred, failure, identity, input, key, memoryStorage, nextKey, receipt, setup, view} from './model-token-quotas.fixture';

afterEach(() => vi.unstubAllGlobals());
describe('Exact durable policy writes and owner recovery', () => {
    it('reads a user without usage or a policy without an automatic choice or write', async () => {
        const f = setup(); await f.controller.initialize();
        expect(f.state().view?.policy).toBeNull(); expect(f.state().draft).toEqual({enabled: true, tokenLimit: null, duration: 1, unit: 'day'});
        expect(f.api.write).not.toHaveBeenCalled(); expect(f.api.receipt).not.toHaveBeenCalled();
    });
    it('persists the full body before PUT and can preconfigure while enforcement is OFF', async () => {
        const f = setup({initial: view({featureEnabled: false})}); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000);
        f.api.write.mockImplementationOnce(async body => {expect(JSON.parse(f.storage.getItem(quotaStorageKey(identity))!).input).toEqual(body); return receipt(body);});
        f.api.read.mockResolvedValueOnce(view({featureEnabled: false, policy: (await receipt()).policy}));
        await f.controller.save(); expect(f.api.write).toHaveBeenCalledOnce(); expect(f.state().pending).toBeUndefined(); expect(f.state().view?.featureEnabled).toBe(false); expect(f.state().receipt?.requestKey).toBe(key);
    });
    it('settles lost ACK only by exact receipt, never an identical latest policy', async () => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000); f.api.write.mockRejectedValueOnce(Error('ACK lost')); await f.controller.save();
        const raw = f.storage.getItem(quotaStorageKey(identity)); expect(f.state().pending?.input).toEqual(input()); expect(f.state().canReplay).toBe(true);
        f.api.read.mockResolvedValueOnce(view({policy: (await receipt()).policy})); await f.controller.refresh();
        expect(f.storage.getItem(quotaStorageKey(identity))).toBe(raw); expect(f.state().pending).toBeDefined();
        f.api.receipt.mockResolvedValueOnce(await receipt()); f.api.read.mockResolvedValueOnce(view({policy: (await receipt()).policy})); await f.controller.recover(); expect(f.state().pending).toBeUndefined(); expect(f.api.write).toHaveBeenCalledOnce();
    });
    it('restores an unknown intent after reload and404 without dispatch, then replays identical body/key explicitly', async () => {
        const store = memoryStorage(), first = setup({storage: store}); await first.controller.initialize(); first.controller.edit('tokenLimit', 10000); first.api.write.mockRejectedValueOnce(Error('HTTP503')); await first.controller.save(); first.controller.dispose();
        const raw = store.getItem(quotaStorageKey(identity)), reloaded = setup({storage: store}); await reloaded.controller.initialize();
        expect(store.getItem(quotaStorageKey(identity))).toBe(raw); expect(reloaded.state().pending?.input).toEqual(input()); expect(reloaded.api.write).not.toHaveBeenCalled();
        reloaded.controller.edit('tokenLimit', 999); expect(reloaded.state().draft.tokenLimit).toBe(10000);
        reloaded.api.write.mockImplementationOnce(body => receipt(body)); reloaded.api.read.mockResolvedValueOnce(view({policy: (await receipt()).policy})); await reloaded.controller.replay();
        expect(reloaded.api.write.mock.calls[0][0]).toEqual(first.api.write.mock.calls[0][0]); expect(store.getItem(quotaStorageKey(identity))).toBeNull();
    });
    it('keeps pending after a mismatching receipt and disables silent new writes', async () => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000);
        f.api.write.mockResolvedValueOnce(await receipt(input(), {...identity, userEmail: 'other@example.test'})); await f.controller.save();
        expect(f.state().pending?.input.requestKey).toBe(key); expect(f.state().receipt).toBeUndefined(); expect(f.api.write).toHaveBeenCalledOnce();
        await f.controller.save(); expect(f.api.write).toHaveBeenCalledOnce();
    });
    it('preserves draft on CAS conflict until explicit comparison, then uses a new key and chosen revision', async () => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000);
        const current = (await receipt(input({tokenLimit: 20000, expectedRevision: 1}))).policy;
        f.api.write.mockRejectedValueOnce(failure(409, 'Обновите ревизию', 'MODEL_TOKEN_QUOTA_REVISION_CONFLICT')); f.api.read.mockResolvedValueOnce(view({policy: current})); await f.controller.save();
        expect(f.state().draft.tokenLimit).toBe(10000); expect(f.state().conflict?.policy?.tokenLimit).toBe(20000); expect(f.state().pending).toBeDefined();
        f.controller.resolveConflict(true); expect(f.state().pending).toBeUndefined(); expect(f.state().draft.tokenLimit).toBe(10000); expect(f.state().baseRevision).toBe(2);
        f.api.write.mockImplementationOnce(body => receipt(body)); f.api.read.mockResolvedValueOnce(view({policy: (await receipt(input({requestKey: nextKey, expectedRevision: 2}))).policy})); await f.controller.save(); expect(f.api.write.mock.calls[1][0]).toEqual(input({requestKey: nextKey, expectedRevision: 2}));
    });
    it.each([false, true])('clears the resolved missing-receipt warning without replay when keeping draft=%s', async keepDraft => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000);
        const current = (await receipt(input({tokenLimit: 20000, expectedRevision: 1}))).policy;
        f.api.write.mockRejectedValueOnce(failure(409, 'Обновите ревизию', 'MODEL_TOKEN_QUOTA_REVISION_CONFLICT')); f.api.read.mockResolvedValueOnce(view({policy: current})); await f.controller.save();
        expect(f.state().error).toContain('Подтверждение пока не найдено'); expect(f.state().pending?.input).toEqual(input());
        expect(f.state().rejected).toBe(true); expect(f.state().missing).toBe(true);
        f.controller.resolveConflict(keepDraft);
        expect(f.state().error).toBe(''); expect(f.state().notice).toBeTruthy(); expect(f.state().pending).toBeUndefined();
        expect(f.state().draft.tokenLimit).toBe(keepDraft ? 10000 : 20000); expect(f.state().baseRevision).toBe(2);
        expect(f.state().conflict).toBeUndefined(); expect(f.state().rejected).toBe(false); expect(f.state().missing).toBe(false); expect(f.state().canReplay).toBe(false);
        expect(f.storage.getItem(quotaStorageKey(identity))).toBeNull(); await f.controller.replay();
        expect(f.api.write).toHaveBeenCalledOnce(); expect(f.api.receipt).toHaveBeenCalledOnce(); expect(f.api.read).toHaveBeenCalledTimes(2);
    });
    it('keeps the unresolved warning and checkpoint if another tab blocks conflict resolution', async () => {
        const store = memoryStorage(), f = setup({storage: store}); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000);
        f.api.write.mockRejectedValueOnce(failure(409, 'Обновите ревизию', 'MODEL_TOKEN_QUOTA_REVISION_CONFLICT'));
        f.api.read.mockResolvedValueOnce(view({policy: (await receipt(input({tokenLimit: 20000, expectedRevision: 1}))).policy})); await f.controller.save();
        store.setItem(quotaStorageKey(identity), 'OTHER_TAB_BYTES'); f.controller.resolveConflict(false);
        expect(f.state().error).toContain('Подтверждение пока не найдено'); expect(f.state().notice).toBe(''); expect(f.state().pending?.input).toEqual(input());
        expect(f.state().storageError).toBeTruthy(); expect(store.getItem(quotaStorageKey(identity))).toBe('OTHER_TAB_BYTES'); expect(f.api.write).toHaveBeenCalledOnce();
    });
    it('can explicitly adopt the current policy without silently replacing the draft', async () => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 123);
        f.api.read.mockResolvedValueOnce(view({policy: (await receipt(input({tokenLimit: 500}))).policy})); await f.controller.refresh(); expect(f.state().draft.tokenLimit).toBe(123);
        f.controller.resolveConflict(false); expect(f.state().draft.tokenLimit).toBe(500); expect(f.api.write).not.toHaveBeenCalled();
    });
    it('fresh403 hides private counters/receipt but keeps the exact unresolved journal', async () => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000); f.api.write.mockRejectedValueOnce(Error('Lost ACK')); await f.controller.save();
        const raw = f.storage.getItem(quotaStorageKey(identity)); f.api.read.mockRejectedValueOnce(failure(403)); await f.controller.refresh();
        expect(f.state().view).toBeUndefined(); expect(f.state().receipt).toBeUndefined(); expect(f.storage.getItem(quotaStorageKey(identity))).toBe(raw);
        await f.controller.replay(); expect(f.api.write).toHaveBeenCalledOnce();
    });
    it('denies saving under read-only authority and keeps invalid entered values without transport', async () => {
        const readOnly = setup({initial: view({canManage: false})}); await readOnly.controller.initialize(); readOnly.controller.edit('tokenLimit', 1); await readOnly.controller.save(); expect(readOnly.api.write).not.toHaveBeenCalled();
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 1); f.controller.edit('duration', 366); await f.controller.save();
        expect(f.api.write).not.toHaveBeenCalled(); expect(f.state().draft.duration).toBe(366); expect(f.state().error).toContain('365');
    });
    it('corrupt journal and unavailable storage block dispatch, preserving original bytes and local input', async () => {
        const store = memoryStorage(), raw = '{"schemaVersion":1,"input":'; store.setItem(quotaStorageKey(identity), raw);
        const f = setup({storage: store}); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000); await f.controller.save(); expect(f.api.write).not.toHaveBeenCalled(); expect(store.getItem(quotaStorageKey(identity))).toBe(raw);
        const broken = setup({storage: {getItem: () => null, setItem: () => {throw Error('Storage full');}, removeItem: () => undefined}}); await broken.controller.initialize(); broken.controller.edit('tokenLimit', 10000); await broken.controller.save();
        expect(broken.api.write).not.toHaveBeenCalled(); expect(broken.state().draft.tokenLimit).toBe(10000); expect(broken.state().storageError).toBeTruthy();
    });
    it('an observed other-tab checkpoint is not overwritten or removed by this editor', async () => {
        const store = memoryStorage(), f = setup({storage: store}); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000);
        store.setItem(quotaStorageKey(identity), 'OTHER_TAB_BYTES'); await f.controller.save(); expect(f.api.write).not.toHaveBeenCalled(); expect(store.getItem(quotaStorageKey(identity))).toBe('OTHER_TAB_BYTES');
    });
    it('deduplicates save and ignores late accepted results after auth revocation', async () => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000); const late = deferred<QuotaReceipt>(); f.api.write.mockReturnValueOnce(late.promise);
        const saving = f.controller.save(); await f.controller.save(); expect(f.api.write).toHaveBeenCalledOnce(); f.revoke(); late.resolve(await receipt()); await saving;
        expect(f.state().receipt).toBeUndefined(); expect(f.storage.getItem(quotaStorageKey(identity))).not.toBeNull();
    });
    it('dispose aborts its transport and a late old-model reply cannot populate the next selected target', async () => {
        const old = setup(), late = deferred<QuotaView>(); old.api.read.mockReturnValueOnce(late.promise); const reading = old.controller.initialize(); old.controller.dispose(); expect(old.api.read.mock.calls[0][0].aborted).toBe(true);
        const who = {...identity, modelId: 'model-b', userEmail: 'other@example.test'}, fresh = setup({identity: who}); await fresh.controller.initialize(); late.resolve(view()); await reading;
        expect(old.state().view).toBeUndefined(); expect(fresh.state().view).toMatchObject({modelId: 'model-b', userEmail: 'other@example.test'}); expect(quotaStorageKey(who)).not.toBe(quotaStorageKey(identity));
    });
    it('hides old remaining/overrun after a changed limit and period until an authoritative balance arrives', async () => {
        const oldPolicy = (await receipt(input({tokenLimit: 1000}))).policy;
        const initial = view({policy: oldPolicy}); Object.assign(initial.counters, {chargedTokens: '200', remainingTokens: '800', overrunTokens: '0'});
        const f = setup({initial}); await f.controller.initialize(); f.controller.edit('tokenLimit', 100); f.controller.edit('duration', 2);
        const accepted = await receipt(input({tokenLimit: 100, expectedRevision: 1, periodMs: 172800000})); f.api.write.mockResolvedValueOnce(accepted);
        const started = deferred<void>(), balance = deferred<QuotaView>(); f.api.read.mockImplementationOnce(() => {started.resolve(); return balance.promise;});
        const saving = f.controller.save(); await started.promise;
        expect(f.state().receipt).toEqual(accepted); expect(f.state().view).toBeUndefined(); expect(f.state().pending).toBeUndefined();
        const current = view({policy: accepted.policy}); Object.assign(current.counters, {chargedTokens: '200', remainingTokens: '0', overrunTokens: '100'}); balance.resolve(current); await saving;
        expect(f.state().view?.counters).toMatchObject({remainingTokens: '0', overrunTokens: '100'}); expect(f.state().view?.policy?.periodMs).toBe(172800000); expect(f.api.write).toHaveBeenCalledOnce();
    });
    it('a balance read failure preserves the successful exact write and recovers with GET only', async () => {
        const f = setup(); await f.controller.initialize(); f.controller.edit('tokenLimit', 10000); const accepted = await receipt(); f.api.write.mockResolvedValueOnce(accepted); f.api.read.mockRejectedValueOnce(Error('Balance503'));
        await f.controller.save(); expect(f.state().receipt).toEqual(accepted); expect(f.state().notice).toContain('подтверждена'); expect(f.state().view).toBeUndefined(); expect(f.state().error).toContain('Квота сохранена'); expect(f.state().pending).toBeUndefined();
        await f.controller.save(); expect(f.api.write).toHaveBeenCalledOnce(); expect(f.api.receipt).not.toHaveBeenCalled();
        f.api.read.mockResolvedValueOnce(view({policy: accepted.policy})); await f.controller.refresh(); expect(f.state().view?.policy).toEqual(accepted.policy); expect(f.api.write).toHaveBeenCalledOnce();
    });
    it('keeps the acknowledged revision floor through stale initial and explicit retry reads, accepting only a fresh balance', async () => {
        const oldPolicy = (await receipt(input({tokenLimit: 1000}))).policy, f = setup({initial: view({policy: oldPolicy})}); await f.controller.initialize(); f.controller.edit('tokenLimit', 100);
        const accepted = await receipt(input({expectedRevision: 1, tokenLimit: 100}));
        const old = view({policy: oldPolicy}); Object.assign(old.counters, {remainingTokens: '800', overrunTokens: '0'});
        f.api.write.mockResolvedValueOnce(accepted); f.api.read.mockResolvedValueOnce(old); await f.controller.save();
        expect(f.state().receipt?.policy.revision).toBe(2); expect(f.state().view).toBeUndefined(); expect(f.state().error).toContain('Квота сохранена');
        f.api.read.mockResolvedValueOnce(old); await f.controller.refresh();
        expect(f.state().view).toBeUndefined(); expect(f.state().error).toContain('сохранение уже подтверждено'); expect(f.state().receipt?.policy.revision).toBe(2);
        const fresh = view({policy: accepted.policy}); Object.assign(fresh.counters, {remainingTokens: '0', overrunTokens: '100'});
        f.api.read.mockResolvedValueOnce(fresh); await f.controller.refresh();
        expect(f.state().view?.policy?.revision).toBe(2); expect(f.state().view?.counters).toMatchObject({remainingTokens: '0', overrunTokens: '100'}); expect(f.api.write).toHaveBeenCalledOnce();
    });
});
