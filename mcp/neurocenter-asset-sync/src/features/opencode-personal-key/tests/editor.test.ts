import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersonalKeyEditor } from '../editor.js';
import type { IPersonalKeyOptions } from '../interfaces.js';
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'personal-key-test-')));
    roots.push(home);
    const auth = path.join(home, '.local/share/opencode/auth.json');
    await fs.mkdir(path.dirname(auth), { recursive: true, mode: 0o700 });
    await fs.writeFile(
        auth,
        JSON.stringify({
            openai: { type: 'api', key: 'synthetic-key-only' },
            other: { type: 'oauth', refresh: 'retained' },
        }),
        { mode: 0o600 },
    );
    const jobId = '11111111-1111-4111-8111-111111111111',
        payload = {
            schemaVersion: 1 as const,
            scope: 'global' as const,
            deviceId: '22222222-2222-4222-8222-222222222222',
            modelId: 'model',
            providerId: 'a'.repeat(64),
            expectedConnectionRevision: 2,
            expectedCredentialRevision: 3,
            requestKey: '33333333-3333-4333-8333-333333333333',
            expiresAt: '2099-01-01T00:00:00.000Z',
        };
    const context = {
        ok: true as const,
        expiresAt: payload.expiresAt,
        requestKey: payload.requestKey,
        recipient: {
            ownerEmail: 'owner@example.test',
            modelId: payload.modelId,
            modelName: 'OpenAI',
            providerId: payload.providerId,
            providerUrl: 'https://api.openai.com/v1' as const,
            connectionRevision: 2,
            credentialRevision: 3,
            authMode: 'required' as const,
            canStoreKey: true,
        },
    };
    const receipt = {
        schemaVersion: 1,
        jobId,
        requestKey: payload.requestKey,
        modelId: payload.modelId,
        providerId: payload.providerId,
        connectionRevision: 2,
        credentialRevision: 4,
        hasKey: true,
        acceptedAt: '2026-11-01T00:00:00.000Z',
    };
    let accepted: unknown = null,
        loseAck = false,
        enabled = true;
    const wire = vi.fn(async (route: string) => {
        if (route === 'receipt') return { receipt: accepted };
        if (!enabled) throw Error('OFF');
        if (route === 'context') return context;
        accepted = receipt;
        if (loseAck) throw Error('lost ACK');
        return receipt;
    });
    const options: IPersonalKeyOptions = {
        jobId,
        payload,
        context,
        home,
        environment: {},
        journalDirectory: path.join(home, 'journal'),
        siteOrigin: 'https://site.example.test',
        apiOrigin: 'https://api.example.test',
        ownerEmail: context.recipient.ownerEmail,
        authorize: vi.fn(async () => undefined),
        current: () => {},
        assertCompatibleCli: vi.fn(async () => ({ assertCurrent: async () => {} })),
        wire,
    };
    return {
        home,
        auth,
        options,
        editor: new PersonalKeyEditor(options),
        wire,
        receipt,
        lose: () => {
            loseAck = true;
        },
        off: () => {
            enabled = false;
        },
        unsafeReceipt: () => {
            accepted = { ...receipt, requestHash: 'not-public' };
        },
    };
}
describe('explicit personal key transfer', () => {
    it('opening metadata does not send a key; explicit save preserves local auth and writes a secret-free intent', async () => {
        const f = await fixture(),
            before = await fs.readFile(f.auth, 'utf8');
        expect(JSON.stringify(await f.editor.inventory())).not.toContain('synthetic-key-only');
        expect(f.wire).not.toHaveBeenCalled();
        const preview = await f.editor.prepare({});
        expect(f.wire.mock.calls.some(([route]) => route === 'save')).toBe(false);
        expect(await f.editor.save({ previewId: preview.previewId })).toEqual({ status: 'saved', receipt: f.receipt });
        expect(await fs.readFile(f.auth, 'utf8')).toBe(before);
        const intent = await fs.readFile(path.join(f.options.journalDirectory, f.options.jobId + '.json'), 'utf8');
        expect(intent).not.toContain('synthetic-key-only');
        expect(intent).not.toContain('requestHash');
        expect(JSON.parse(intent).sourceFingerprint).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
    });
    it('lost acknowledgement reconciles the same request while OFF without another key send', async () => {
        const f = await fixture(),
            preview = await f.editor.prepare({});
        f.lose();
        await expect(f.editor.save({ previewId: preview.previewId })).rejects.toThrow();
        f.off();
        expect(await f.editor.save({ previewId: preview.previewId })).toEqual({ status: 'saved', receipt: f.receipt });
        expect(f.wire.mock.calls.filter(([route]) => route === 'save')).toHaveLength(1);
    });
    it('rejects OAuth rather than treating it as an API key', async () => {
        const f = await fixture();
        await fs.writeFile(f.auth, JSON.stringify({ openai: { type: 'oauth', access: 'synthetic' } }));
        await expect(f.editor.prepare({})).rejects.toThrow();
        expect(f.wire.mock.calls.some(([route]) => route === 'save')).toBe(false);
    });
    it('an external source edit after consent prevents transmission', async () => {
        const f = await fixture(),
            preview = await f.editor.prepare({});
        await fs.writeFile(f.auth, JSON.stringify({ openai: { type: 'api', key: 'changed' } }));
        await expect(f.editor.save({ previewId: preview.previewId })).rejects.toThrow();
        expect(f.wire.mock.calls.some(([route]) => route === 'save')).toBe(false);
    });
    it('fresh CLI ownership and flag revocation prevent transmission', async () => {
        const f = await fixture(),
            preview = await f.editor.prepare({});
        vi.mocked(f.options.assertCompatibleCli).mockRejectedValueOnce(Error('changed CLI'));
        await expect(f.editor.save({ previewId: preview.previewId })).rejects.toThrow();
        f.off();
        await expect(f.editor.save({ previewId: preview.previewId })).rejects.toThrow();
        expect(f.wire.mock.calls.some(([route]) => route === 'save')).toBe(false);
    });
    it('never exposes extra receipt fields from a server response', async () => {
        const f = await fixture();
        f.unsafeReceipt();
        await expect(f.editor.lastSave()).rejects.toThrow();
    });
});
