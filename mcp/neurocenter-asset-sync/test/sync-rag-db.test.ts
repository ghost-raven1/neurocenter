import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncRagDb } from '../src/tools/sync-rag-db.js';
import { writeRows, deleteIds } from '../src/lib/lancedb.js';
import { workspaceFixture } from './bridge-fixture.js';
import { readyIndex, row, profile, metadata } from './rag-index-fixture.js';
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/bridge/state.js', async original => ({ ...await original<typeof import('../src/bridge/state.js')>(), authorizedFetch: transport.fetch }));

describe('Безопасная передача проверенного RAG-снимка', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let store: string;
    let server: Record<string, ReturnType<typeof row>>;
    let requests: any[];
    beforeEach(async () => {
        fixture = await workspaceFixture(); store = path.join(fixture.root, '.opencode/rag_db'); requests = [];
        await readyIndex(fixture.root); await writeRows(store, [row('a'), row('b')], false, 3);
        server = Object.fromEntries([row('a'), row('b'), row('obsolete')].map(value => [value.id, value]));
        transport.fetch.mockReset().mockImplementation(async (_route: string, options?: RequestInit) => {
            if (!options) { return Response.json(metadata(Object.values(server))); }
            const body = JSON.parse(String(options.body)); requests.push(body);
            for (const value of body.chunks) { server[value.id] = value; }
            for (const id of body.deletes) { delete server[id]; }
            return Response.json({ upserted: body.chunks.length, deleted: body.deletes.length,
                complete: body.snapshot.complete, snapshotHash: body.snapshot.hash });
        });
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    const run = (input = {}) => syncRagDb({ project: fixture.root, ...input }, fixture.root);

    it.each([false, true])('Неполный скан dryRun=%s не вычисляет удаления и не пишет', async dryRun => {
        expect(JSON.parse(await run({ scanLimit: 1, dryRun }))).toMatchObject({ applied: false, scanComplete: false, removedCount: null });
        expect(requests).toEqual([]);
    });
    it('Удаляет отсутствующее только после полного скана и отдельно запечатывает снимок', async () => {
        expect(JSON.parse(await run())).toMatchObject({ ok: true, complete: true, remaining: 0, deleted: 1, localCount: 2 });
        expect(requests.map(body => [body.chunks.length, body.deletes, body.snapshot.complete])).toEqual([[0, ['obsolete'], false], [0, [], true]]);
    });
    it('Порция ограничивает записи и удаления вместе, не запечатывает остаток', async () => {
        server = { old: row('old') };
        expect(JSON.parse(await run({ limit: 2 }))).toMatchObject({ complete: false, appliedNow: 2, remaining: 1 });
        expect(requests.flatMap(body => body.deletes)).toEqual([]);
        expect(requests.every(body => body.snapshot.complete === false)).toBe(true);
    });
    it('Изменение только вектора или метаданных передаётся без изменения content', async () => {
        await writeRows(store, [{ ...row('a'), description: 'changed', embedding: [0.3, 0.2, 0.1] }], false, 3);
        expect(JSON.parse(await run())).toMatchObject({ upserted: 1, complete: true });
        expect(requests[0].chunks[0]).toMatchObject({ id: 'a', description: 'changed', filePath: 'README.md' });
    });
    it('Пустой локальный индекс не очищает серверную копию', async () => {
        await deleteIds(store, ['a', 'b']);
        await expect(run()).rejects.toThrow('пуст'); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it.each(['missing', 'indexing', 'failed', 'model', 'endpoint'])('Неподтверждённое происхождение %s не отправляет ни одного запроса', async mode => {
        const file = path.join(store, 'neurocenter-index-profile.json');
        if (mode === 'missing') { await fs.rm(file); }
        else {
            const value = JSON.parse(await fs.readFile(file, 'utf8'));
            if (mode === 'model') { value.profile.model = 'other-model'; }
            else if (mode === 'endpoint') { value.embeddingSignature = '0'.repeat(64); }
            else { value.state = mode; }
            await fs.writeFile(file, JSON.stringify(value));
        }
        await expect(run()).rejects.toThrow(/Происхождение|Модели|изменились/); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it.each([{ running: true }, { lastPassProblems: 1 }, { consecutiveFailures: 1 }, { lastChangeAt: 11 }, { lastRunAt: 12 }])('Незавершённый проход %j не начинает передачу', async patch => {
        await fs.writeFile(path.join(store, 'watcher-status.json'), JSON.stringify({ running: false, lastSuccessAt: 10, ...patch }));
        await expect(run()).rejects.toThrow(/готов|индексац/); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it('Живой индексатор блокирует любые изменения', async () => {
        await fs.writeFile(path.join(store, 'index.lock'), JSON.stringify({ pid: process.pid }));
        await expect(run()).rejects.toThrow('Идёт индексация'); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it('Нулевая или отсутствующая embedding-строка не получает успешный seal', async () => {
        await writeRows(store, [{ ...row('a'), embedding: null }], false, 3);
        await expect(run()).rejects.toThrow('неполные векторы'); expect(requests).toEqual([]);
    });
    it('Сервер старой версии не принимает новую запись', async () => {
        transport.fetch.mockResolvedValue(Response.json({ ids: {} }));
        await expect(run()).rejects.toThrow('V1'); expect(requests).toEqual([]);
    });
    it('Другая модель с той же размерностью отклоняется до записи', async () => {
        transport.fetch.mockResolvedValue(Response.json({ ...metadata(Object.values(server)), indexProfile: { ...profile, model: 'different' } }));
        await expect(run()).rejects.toThrow('Модели'); expect(requests).toEqual([]);
    });
    it('Непроверенные legacy-строки полностью переотправляются и устаревшие удаляются', async () => {
        const implementation = transport.fetch.getMockImplementation()!;
        transport.fetch.mockImplementation(async (route, options) => !options
            ? Response.json({ ...metadata(Object.values(server), false), indexProfile: null, fingerprints: {}, incompleteRows: 3 })
            : implementation(route, options));
        expect(JSON.parse(await run())).toMatchObject({ complete: true, upserted: 2, deleted: 1 });
    });
    it('Смена версии LanceDB после manifest не отправляет и не удаляет строки', async () => {
        transport.fetch.mockImplementationOnce(async () => {
            await writeRows(store, [row('new')], false, 3); return Response.json(metadata(Object.values(server)));
        });
        await expect(run()).rejects.toThrow('индекс изменился'); expect(requests).toEqual([]);
    });
    it('Отказ embedding-записи не разрешает последующие удаления', async () => {
        server = { obsolete: row('obsolete') };
        transport.fetch.mockImplementationOnce(async () => Response.json(metadata(Object.values(server))))
            .mockResolvedValueOnce(new Response('internal-secret', { status: 503 }));
        await expect(run()).rejects.toThrow('503'); expect(requests.flatMap(body => body.deletes)).toEqual([]);
    });
    it('Отказ второй порции сообщает подтверждённый объём, повтор отправляет остаток и запечатывает', async () => {
        await writeRows(store, Array.from({ length: 101 }, (_, index) => row(String(index))), true, 3);
        server = { obsolete: row('obsolete') }; let posts = 0; let refuse = true;
        const implementation = transport.fetch.getMockImplementation()!;
        transport.fetch.mockImplementation(async (route, options) => {
            if (options && ++posts === 2 && refuse) { return Response.json({ code: 'RAG_QUOTA_EXCEEDED', message: 'Попросите администратора увеличить лимит базы знаний.' }, { status: 413 }); }
            return implementation(route, options);
        });
        await expect(run()).rejects.toThrow('Ранее подтверждено фрагментов: 100');
        expect(server.obsolete).toBeDefined(); refuse = false;
        expect(JSON.parse(await run())).toMatchObject({ complete: true, upserted: 1, deleted: 1, remaining: 0 });
        expect(Object.keys(server)).toHaveLength(101);
    });
    it('Неполная серверная квитанция запрещает seal и удаления', async () => {
        server = { obsolete: row('obsolete') };
        transport.fetch.mockImplementationOnce(async () => Response.json(metadata(Object.values(server))))
            .mockResolvedValueOnce(Response.json({ upserted: 1 }));
        await expect(run()).rejects.toThrow('не все'); expect(requests).toEqual([]);
    });
    it('Отказ серверного seal не становится зелёным завершением', async () => {
        const implementation = transport.fetch.getMockImplementation()!;
        transport.fetch.mockImplementation(async (route, options) => options && JSON.parse(String(options.body)).snapshot.complete
            ? Response.json({ complete: false }) : implementation(route, options));
        await expect(run()).rejects.toThrow('целостность');
    });
    it('Свежий idle watcher разрешает синхронизацию без остановки OpenCode', async () => {
        await fs.writeFile(path.join(store, 'watcher.lock'), JSON.stringify({ pid: process.pid }));
        expect(JSON.parse(await run())).toMatchObject({ complete: true });
    });
    it('Ручной native-проход без watcher принимается только с точной подтверждённой датой manifest', async () => {
        await fs.rm(path.join(store, 'watcher-status.json'));
        expect(JSON.parse(await run())).toMatchObject({ complete: true });
        const file = path.join(store, 'neurocenter-index-profile.json');
        const value = JSON.parse(await fs.readFile(file, 'utf8')); value.indexedAt++;
        await fs.writeFile(file, JSON.stringify(value));
        await expect(run()).rejects.toThrow('Полный проход');
    });
    it('Повторная авторизация перед POST блокирует отозванную привязку', async () => {
        let calls = 0;
        await expect(syncRagDb({ project: fixture.root }, fixture.root, async () => { if (++calls === 2) { throw new Error('отозвано'); } })).rejects.toThrow('отозвано');
        expect(requests).toEqual([]);
    });
});
