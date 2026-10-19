import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncRagDb } from '../src/tools/sync-rag-db.js';
import { writeRows } from '../src/lib/lancedb.js';
import { workspaceFixture } from './bridge-fixture.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/bridge/state.js', async original => ({ ...await original<typeof import('../src/bridge/state.js')>(), authorizedFetch: transport.fetch }));

describe('Границы локального источника RAG при отправке', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let store: string;
    const sent: unknown[] = [];
    const row = (id: string) => ({ id, content: id, description: null, filePath: 'README.md', startLine: null, endLine: null, language: null, kind: null, role: null, quirkType: null, tags: null, embedding: [0.1, 0.2, 0.3] });
    beforeEach(async () => {
        fixture = await workspaceFixture(); store = path.join(fixture.root, '.opencode/rag_db'); sent.length = 0;
        await writeRows(store, [row('own-row')], false, 3);
        transport.fetch.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
            if (!init) { return Response.json({ ids: {} }); }
            const body = JSON.parse(String(init.body)); sent.push(body);
            return Response.json({ upserted: body.chunks.length, deleted: body.deletes.length });
        });
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it.each(['config', 'symlink'])('Не отправляет чужой индекс через %s', async mode => {
        const outside = path.join(fixture.temporary, 'outside/rag_db');
        await writeRows(outside, [row('foreign-private-row')], false, 3);
        if (mode === 'config') {
            await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ vectorStore: { path: outside } }));
        } else {
            await fs.rm(store, { recursive: true }); await fs.symlink(outside, store, 'dir');
        }
        let outcome: unknown;
        try { outcome = JSON.parse(await syncRagDb({ project: fixture.root }, fixture.root)); }
        catch (error) { outcome = { refused: error instanceof Error ? error.message : String(error) }; }
        expect({ outcome, sent, requests: transport.fetch.mock.calls.length }).toMatchObject({
            outcome: { refused: expect.stringMatching(/внутри|симлинк/) }, sent: [], requests: 0,
        });
    });

    it('Подтверждённый локальный индекс отправляется по обычному протоколу', async () => {
        expect(JSON.parse(await syncRagDb({ project: fixture.root }, fixture.root))).toMatchObject({ ok: true, upserted: 1 });
        expect(sent).toMatchObject([{ projectKey: 'test-project', chunks: [{ id: 'own-row' }], deletes: [] }]);
    });

    it.each(['config', 'symlink'])('Подмена источника через %s после manifest запрещает отправку', async mode => {
        const other = path.join(fixture.root, '.opencode/other-index');
        await writeRows(other, [row('other-private-row')], false, 3);
        transport.fetch.mockImplementationOnce(async () => {
            if (mode === 'config') {
                await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ vectorStore: { path: other } }));
            } else {
                await fs.rm(store, { recursive: true }); await fs.symlink(other, store, 'dir');
            }
            return Response.json({ ids: {} });
        });
        await expect(syncRagDb({ project: fixture.root }, fixture.root)).rejects.toThrow(/Путь локального индекса изменился|симлинк/);
        expect(sent).toEqual([]); expect(transport.fetch).toHaveBeenCalledTimes(1);
    });

    it('Смена источника после принятой порции не выдаёт общий успех', async () => {
        const other = path.join(fixture.root, '.opencode/other-index');
        await writeRows(other, [row('other-private-row')], false, 3);
        const fetch = transport.fetch.getMockImplementation()!;
        transport.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
            const response = await fetch(url, init);
            if (init) { await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ vectorStore: { path: other } })); }
            return response;
        });
        await expect(syncRagDb({ project: fixture.root }, fixture.root)).rejects.toThrow('Путь локального индекса изменился');
        expect(sent).toMatchObject([{ chunks: [{ id: 'own-row' }], deletes: [] }]);
    });
});
