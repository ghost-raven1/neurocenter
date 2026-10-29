// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {webcrypto} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {useModelTokenQuotas} from '../src/features/ModelTokenQuotas/useModelTokenQuotas';
import {quotaStorageKey} from '../src/features/ModelTokenQuotas/storage';
import type {QuotaIdentity, QuotaReceipt} from '../src/features/ModelTokenQuotas/types';
import {deferred, failure, identity, input, receipt, view} from './model-token-quotas.fixture';

const io = vi.hoisted(() => ({owner: 1, read: vi.fn(), write: vi.fn(), receipt: vi.fn()}));
vi.mock('../src/features/ModelTokenQuotas/api', () => ({quotaApi: io}));
const auth = vi.hoisted(() => ({captureOwner: () => {const owner = io.owner; return () => io.owner === owner;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: String(io.owner), captureOwner: auth.captureOwner})}));
let root: Root, container: HTMLDivElement, who: QuotaIdentity, current: ReturnType<typeof useModelTokenQuotas>;
function Probe() {current = useModelTokenQuotas(who); return createElement('span', null, current.state.view?.userEmail ?? current.state.error);}
const render = async () => {await act(async () => {root.render(createElement(Probe));});};
beforeEach(() => {
    vi.resetAllMocks(); io.owner = 1; who = {...identity}; vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
    io.read.mockResolvedValue(view()); io.receipt.mockRejectedValue(failure(404));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

it('loads only the selected model/user and never configures automatically', async () => {
    await render(); expect(io.read).toHaveBeenCalledWith(identity.modelId, identity.userEmail, expect.any(AbortSignal)); expect(io.write).not.toHaveBeenCalled();
    expect(current.state.view?.userEmail).toBe(identity.userEmail); expect(current.state.draft.tokenLimit).toBeNull();
});
it('model/user switch aborts the old save and its late receipt cannot populate the new context', async () => {
    await render(); await act(async () => {current.controller.edit('tokenLimit', 10000);});
    const late = deferred<QuotaReceipt>(); io.write.mockReturnValueOnce(late.promise);
    let writing!: Promise<void>; await act(async () => {writing = current.controller.save();}); const signal = io.write.mock.calls[0][3];
    who = {...identity, modelId: 'model-b', userEmail: 'second@example.test'}; io.read.mockResolvedValueOnce(view({modelId: who.modelId, userEmail: who.userEmail})); await render();
    expect(signal.aborted).toBe(true); await act(async () => {late.resolve(await receipt()); await writing;});
    expect(current.state.receipt).toBeUndefined(); expect(container.textContent).toBe(who.userEmail); expect(localStorage.getItem(quotaStorageKey(identity))).not.toBeNull();
});
it('auth/role scope change isolates the original journal and ignores its pending acknowledgement', async () => {
    await render(); await act(async () => {current.controller.edit('tokenLimit', 10000);}); const late = deferred<QuotaReceipt>(); io.write.mockReturnValueOnce(late.promise);
    let writing!: Promise<void>; await act(async () => {writing = current.controller.save();});
    io.owner++; who = {...identity, scope: 'different-role-session'}; await render(); await act(async () => {late.resolve(await receipt()); await writing;});
    expect(current.state.pending).toBeUndefined(); expect(current.state.receipt).toBeUndefined(); expect(localStorage.getItem(quotaStorageKey(identity))).not.toBeNull(); expect(io.write).toHaveBeenCalledOnce();
});
it('storage events block stale-tab writes without overwriting the newer raw checkpoint', async () => {
    await render(); await act(async () => {current.controller.edit('tokenLimit', 10000);}); const key = quotaStorageKey(identity), raw = JSON.stringify({schemaVersion: 1, ...identity, input: input()});
    localStorage.setItem(key, raw); await act(async () => {window.dispatchEvent(new StorageEvent('storage', {key, newValue: raw})); await current.controller.save();});
    expect(current.state.storageError).toContain('другой вкладке'); expect(io.write).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(raw);
    await act(async () => {await current.controller.reloadJournal();}); expect(current.state.pending?.input).toEqual(input()); expect(io.write).not.toHaveBeenCalled();
});
