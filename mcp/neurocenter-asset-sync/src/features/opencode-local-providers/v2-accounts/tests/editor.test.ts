vi.mock('../../../system-role-mcp/owned-process.js', () => ({
    roleMcpProcessOwner: async () => ({ birth: 'fixture-owned' }),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRequest } from '../transport.js';
vi.mock('../transport.js', () => ({ accountRequest: vi.fn() }));
import { AccountsEditor } from '../editor.js';
import { contract } from '../../contract.js';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('../../files.js', () => ({
    snapshot: async (file: string) => ({
        file,
        text: disk.get(file) ?? null,
        fingerprint: disk.get(file) ?? null,
        secret: true,
    }),
    unchanged: async (before: { file: string; text: string | null }) => {
        if ((disk.get(before.file) ?? null) !== before.text) throw Error('changed');
    },
    publish: async (
        before: { file: string; text: string | null },
        text: string,
        _maximum: number,
        authorize: () => Promise<void>,
        verify: () => Promise<void>,
    ) => {
        await authorize();
        await verify();
        if ((disk.get(before.file) ?? null) !== before.text) throw Error('changed');
        disk.set(before.file, text);
    },
    conflict: () => Object.assign(Error('conflict'), { code: 'GLOBAL_PROVIDER_CONFLICT' }),
}));
const registration = {
    id: 'fixture',
    version: '2.2.2',
    url: 'http://127.0.0.1:12345',
    pid: 42,
    password: 'private-fixture',
};
let rows: Array<{ id: string; integrationID: string; value: { type: string; key?: string } }>;
let lostAck: boolean, writes: number;
const authorized = vi.fn(async () => {}),
    proof = vi.fn(async () => {});
const editor = () =>
    new AccountsEditor({
        home: '/owned',
        environment: {},
        authorize: authorized,
        assertCompatibleCli: async () => ({ assertCurrent: proof }),
        limits: contract.globalProvidersLimits({}),
    });
beforeEach(() => {
    disk.clear();
    disk.set('/owned/.local/state/opencode/service.json', JSON.stringify(registration));
    rows = [];
    writes = 0;
    lostAck = false;
    authorized.mockReset();
    proof.mockReset();
    vi.mocked(accountRequest).mockReset();
    vi.mocked(accountRequest).mockImplementation(async (url, _password, _maximum, _signal, body) => {
        if (url.pathname === '/api/info') return { version: '2.2.2', pid: 42 };
        if (url.pathname !== '/api/credential') throw Error('Unexpected route');
        if (body !== undefined) {
            writes++;
            const value = body as (typeof rows)[number] & { activate: boolean };
            expect(value.activate).toBe(false);
            if (rows.some((row) => row.id === value.id)) throw Error('duplicate');
            rows.push(value);
            if (lostAck) throw Error('Lost ACK');
            return value;
        }
        return { data: rows };
    });
});
afterEach(() => vi.unstubAllGlobals());
describe('OpenCode account addition', () => {
    it('projects account auth booleans only, with no keys, labels, IDs or activation', async () => {
        rows = [
            { id: 'private-id', integrationID: 'anthropic', value: { type: 'key', key: 'private-key' } },
            { id: 'oauth-id', integrationID: 'anthropic', value: { type: 'oauth' } },
            { id: 'external-id', integrationID: 'custom', value: { type: 'external' } },
        ];
        expect(await editor().inventory()).toEqual({
            accounts: [
                { integrationId: 'anthropic', hasApiKey: true, hasOAuth: true, hasExternal: false },
                { integrationId: 'custom', hasApiKey: false, hasOAuth: false, hasExternal: true },
            ],
            issues: [],
        });
        expect(writes).toBe(0);
    });
    it('reconciles a lost ACK using the original durable ID and preserves the old account', async () => {
        rows = [{ id: 'old', integrationID: 'anthropic', value: { type: 'key', key: 'old-key' } }];
        const instance = editor(),
            preview = await instance.prepare({ providerId: 'anthropic', apiKey: 'new-key' });
        lostAck = true;
        await instance.save({ previewId: preview.previewId });
        expect(rows).toHaveLength(2);
        expect(rows[0]?.value.key).toBe('old-key');
        expect(writes).toBe(1);
        await editor().resume({ intentId: preview.previewId });
        expect(writes).toBe(1);
        expect(await editor().lastSave()).toEqual({
            intentId: preview.previewId,
            providerId: 'anthropic',
            status: 'saved',
        });
    });
    it('rejects server replacement after preview and never writes', async () => {
        const instance = editor(),
            preview = await instance.prepare({ providerId: 'anthropic', apiKey: 'new-key' });
        disk.set('/owned/.local/state/opencode/service.json', JSON.stringify({ ...registration, id: 'replacement' }));
        await expect(instance.save({ previewId: preview.previewId })).rejects.toThrow();
        expect(writes).toBe(0);
    });
    it('refuses a second intent while the first remains unresolved, then resumes the same ID', async () => {
        const instance = editor(),
            preview = await instance.prepare({ providerId: 'anthropic', apiKey: 'new-key' });
        const request = vi.mocked(accountRequest).getMockImplementation()!;
        vi.mocked(accountRequest).mockImplementation((...args) =>
            args[4] === undefined ? request(...args) : Promise.reject(Error('offline')),
        );
        await expect(instance.save({ previewId: preview.previewId })).rejects.toThrow();
        await expect(editor().prepare({ providerId: 'anthropic', apiKey: 'another' })).rejects.toThrow();
        vi.mocked(accountRequest).mockImplementation(request);
        await editor().resume({ intentId: preview.previewId });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(preview.previewId);
    });
    it('rechecks permissions before mutation and preserves a pending intent', async () => {
        const instance = editor(),
            preview = await instance.prepare({ providerId: 'anthropic', apiKey: 'new-key' });
        authorized.mockRejectedValue(Error('revoked'));
        await expect(instance.save({ previewId: preview.previewId })).rejects.toThrow();
        expect(writes).toBe(0);
    });
    it.each(['custom', 'openai'])('does not accept unsupported integration %s', async (providerId) => {
        await expect(editor().prepare({ providerId, apiKey: 'new-key' })).rejects.toThrow();
        expect(writes).toBe(0);
    });
    it('does not discover remote registrations or start a missing server', async () => {
        disk.set(
            '/owned/.local/state/opencode/service.json',
            JSON.stringify({ ...registration, url: 'https://remote.example' }),
        );
        expect((await editor().inventory()).issues).toEqual(['session-unavailable']);
        expect(accountRequest).not.toHaveBeenCalled();
        disk.clear();
        expect((await editor().inventory()).issues).toEqual(['session-unavailable']);
        expect(accountRequest).not.toHaveBeenCalled();
    });
    it('rejects a mismatched version before requesting credentials', async () => {
        disk.set('/owned/.local/state/opencode/service.json', JSON.stringify({ ...registration, version: '2.2.3' }));
        expect((await editor().inventory()).issues).toEqual(['unsupported-version']);
        expect(accountRequest).not.toHaveBeenCalled();
    });
});
