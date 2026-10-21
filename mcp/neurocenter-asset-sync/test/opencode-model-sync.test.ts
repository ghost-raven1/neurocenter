import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOpenCodeModelSynchronizer, openCodeSnapshotFingerprint, secureOpenCodeCredentialTransport } from '../src/bridge/opencode-model-sync.js';
import type { IOpenCodeModelScan, IOpenCodeModelSource } from '../../../services/shared/opencode-model-scan.cjs';

const binding = { projectId: 'prj-one', bindingId: 'a'.repeat(64), instanceId: randomUUID() };
const scan = (): IOpenCodeModelScan => ({ schemaVersion: 2,scope:'project', ...binding, scanId: randomUUID(), checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), warnings: [], candidates: [{ candidateId: randomUUID(), configKey: 'alias', provider: 'team', name: 'Model', model: 'upstream', modelVersion: 'upstream', runtime: 'remote-openai', capability: 'chat', baseUrl: 'https://provider.example.test/v1', hasKey: true, credentialSource: 'environment', blocker: null, options: { contextWindow: 64000 } }], digest: 'x' });
function fixture(transferCredentials = false, address = 'https://neurocenter.example.test') {
    let identity = { token: 'qa-token', deviceId: randomUUID(), email: 'qa@example.test' };
    const context = { schemaVersion:2,global:{deviceId:identity.deviceId},revision: 1, enabled: true, transferCredentials, bindings: [] as typeof binding[] };
    const api = vi.fn(async (route: string) => route.endsWith('/context') ? context : { changed: true });
    const read = vi.fn(async (_root: string, source: IOpenCodeModelSource, options: { authorize: () => Promise<void>; credentialTarget?: Record<string, string> }) => {
        await options.authorize(); const original=scan(); const value:IOpenCodeModelScan={schemaVersion:2,...source,scanId:original.scanId,checkedAt:original.checkedAt,expiresAt:original.expiresAt,warnings:[],candidates:original.candidates,digest:original.digest};
        if (options.credentialTarget) options.credentialTarget[value.candidates[0]!.candidateId] = 'qa-api-secret';
        return value;
    });
    const dependencies = { api, hub: () => address, readState: async () => identity, projectFolder: async () => '/qa/project', projectBindingId: async () => binding.bindingId, projectInstanceId: async () => binding.instanceId, readOpenCodeModelMetadata: read };
    const sync = createOpenCodeModelSynchronizer(dependencies as unknown as Parameters<typeof createOpenCodeModelSynchronizer>[0]);
    return { sync, api, read, context, dependencies, changeOwner: () => { identity = { ...identity, token: 'new-token', deviceId: randomUUID() }; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('Automatic OpenCode discovery has bounded traffic and explicit credential consent', () => {
    it('discovers global models with no projects and never asks for a project folder',async()=>{
        const f=fixture(),folder=vi.spyOn(f.dependencies,'projectFolder'),bindingReader=vi.spyOn(f.dependencies,'projectBindingId');
        await f.sync();expect(f.read).toHaveBeenCalledOnce();expect(f.read.mock.calls[0]![1]).toEqual({scope:'global',deviceId:f.context.global.deviceId});
        expect(folder).not.toHaveBeenCalled();expect(bindingReader).not.toHaveBeenCalled();
        expect((f.api.mock.calls.find(([route])=>route.endsWith('/sync')) as unknown as [string,{scan:IOpenCodeModelScan}])[1].scan).toMatchObject({scope:'global',deviceId:f.context.global.deviceId});
    });
    it('global and effective project have independent snapshots, and an old or foreign context never scans',async()=>{
        const f=fixture();f.context.bindings=[binding];await f.sync();
        expect(f.read.mock.calls.map(call=>call[1].scope)).toEqual(['global','project']);
        const foreign=fixture();foreign.context.global.deviceId=randomUUID();await foreign.sync();expect(foreign.read).not.toHaveBeenCalled();
        const old=fixture();old.context.schemaVersion=1;await old.sync();expect(old.read).not.toHaveBeenCalled();
    });
    it('fingerprint ignores clock/UUID/key ordering but detects defaults, capacities and key rotation', () => {
        const first = scan(), second = scan();
        expect(openCodeSnapshotFingerprint(first, {})).toBe(openCodeSnapshotFingerprint(second, {}));
        second.candidates[0]!.options!.contextWindow = 128000;
        expect(openCodeSnapshotFingerprint(first, {})).not.toBe(openCodeSnapshotFingerprint(second, {}));
        expect(openCodeSnapshotFingerprint(first, { [first.candidates[0]!.candidateId]: 'key-one' })).not.toBe(openCodeSnapshotFingerprint(first, { [first.candidates[0]!.candidateId]: 'key-two' }));
    });
    it.each(['http://work.example.test', 'http://localhost.evil.test', 'ftp://127.0.0.1', 'invalid'])('never transfers credentials over unsafe address %s', address => { expect(secureOpenCodeCredentialTransport(address)).toBe(false); });
    it.each(['https://work.example.test', 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173'])('permits protected transport or explicit local development %s', address => { expect(secureOpenCodeCredentialTransport(address)).toBe(true); });
    it('deduplicates concurrent calls, debounces heartbeat and periodically acknowledges unchanged metadata', async () => {
        const f = fixture(); await Promise.all([f.sync(), f.sync()]); expect(f.api).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledOnce();
        await f.sync(); expect(f.api).toHaveBeenCalledTimes(2);
        vi.setSystemTime(Date.now() + 60000); await f.sync(); expect(f.read).toHaveBeenCalledTimes(2); expect(f.api.mock.calls.filter(([route]) => route.endsWith('/sync'))).toHaveLength(1);
        vi.setSystemTime(Date.now() + 600000); await f.sync(); expect(f.api.mock.calls.filter(([route]) => route.endsWith('/sync'))).toHaveLength(2);
    });
    it('default discovery does not read or serialize credentials; opt-in sends them only on the device endpoint', async () => {
        const disabled = fixture(); await disabled.sync(); expect(disabled.read.mock.calls[0]![2]).not.toHaveProperty('credentialTarget');
        expect(JSON.stringify(disabled.api.mock.calls)).not.toContain('qa-api-secret');
        const enabled = fixture(true); await enabled.sync(); expect(enabled.read.mock.calls[0]![2]).toHaveProperty('credentialTarget');
        const calls = enabled.api.mock.calls as unknown as [string, { credentials?: Record<string, string> }, string][];
        expect(Object.values(calls.find(([route]) => route.endsWith('/sync'))![1].credentials!)).toEqual(['qa-api-secret']);
        expect(calls.every(([route]) => route.startsWith('opencode-models/'))).toBe(true);
    });
    it('an insecure remote gateway still imports metadata but never opens the key source', async () => {
        const f = fixture(true, 'http://work.example.test'); await f.sync(); expect(f.read.mock.calls[0]![2]).not.toHaveProperty('credentialTarget');
        expect(JSON.stringify(f.api.mock.calls)).not.toContain('qa-api-secret');
    });
    it('a lost ACK retries next minute; provider traffic is never part of discovery', async () => {
        const f = fixture(); f.api.mockImplementationOnce(async () => f.context).mockRejectedValueOnce(Error('Lost ACK'));
        await f.sync(); vi.setSystemTime(Date.now() + 60000); await f.sync();
        expect(f.api.mock.calls.filter(([route]) => route.endsWith('/sync'))).toHaveLength(2);
        expect(f.api.mock.calls.some(([route]) => /infer|chat|embed|check/.test(route))).toBe(false);
    });
    it('changed owner, changed binding or stop before posting prevent delayed key transfer', async () => {
        for (const reason of ['owner', 'binding', 'stop']) {
            let stopped = false; const f = fixture(true);if(reason==='binding')f.context.bindings=[binding];
            const original = f.read.getMockImplementation()!;
            f.read.mockImplementationOnce(async (...args) => { const value = await original(...args); if (reason === 'owner') f.changeOwner(); else if (reason === 'binding') f.dependencies.projectBindingId = async () => 'b'.repeat(64); else stopped = true; return value; });
            await f.sync(() => stopped); expect(f.api.mock.calls.filter(([route]) => route.endsWith('/sync'))).toHaveLength(reason==='binding'?1:0);
        }
    });
    it('an unavailable folder does not prevent another eligible binding from syncing', async () => {
        const f = fixture(); f.context.bindings = [binding, { ...binding, projectId: 'prj-two' }]; f.read.mockRejectedValueOnce(Error('Folder unavailable'));
        await f.sync(); expect(f.read).toHaveBeenCalledTimes(3); expect(f.api.mock.calls.filter(([route]) => route.endsWith('/sync'))).toHaveLength(2);
    });
});
