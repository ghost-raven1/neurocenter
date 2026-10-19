import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreRagDb } from '../src/tools/restore-rag-db.js';
import { enumerateIds, writeRows } from '../src/lib/lancedb.js';
import * as lance from '../src/lib/lancedb.js';
import { readState, writeState } from '../src/bridge/state.js';
import { workspaceFixture } from './bridge-fixture.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/bridge/state.js', async original => ({ ...await original<typeof import('../src/bridge/state.js')>(), authorizedFetch: transport.fetch }));

describe('Скачивание RAG в подтверждённый экземпляр проекта', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let store: string;
    const row = (id: string) => ({ id, content: id, description: null, filePath: 'README.md', startLine: null, endLine: null, language: null, kind: null, role: null, quirkType: null, tags: null, embedding: [0.1, 0.2, 0.3] });
    const page = (values: string[], hasMore = false, projectKey = 'test-project') => Response.json({ projectKey, chunks: values.map(row), dimension: 3, hasMore });
    const ids = async (location = store) => { const values: string[] = []; for await (const id of enumerateIds(location)) { values.push(id); } return values.sort(); };
    const changeGeneration = async () => {
        const marker = JSON.parse(await fs.readFile(path.join(fixture.root, '.opencode/neurocenter.json'), 'utf8'));
        const registry = (await readState<{ instances: Record<string, { bindingNonce: string }> }>('workspace-instances'))!;
        registry.instances[marker.instanceId]!.bindingNonce = randomUUID();
        await writeState('workspace-instances', registry);
    };
    beforeEach(async () => {
        fixture = await workspaceFixture();
        store = path.join(fixture.root, '.opencode/rag_db');
        await fs.mkdir(store, { recursive: true });
        await writeRows(store, [row('local-original')], false, 3);
        transport.fetch.mockReset().mockImplementation(async () => page(['server-row']));
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it('Явный ID другого проекта не заменяет локальную привязку и не удаляет исходный индекс', async () => {
        transport.fetch.mockImplementation(async () => page(['foreign-row'], false, 'other-project'));
        const result = JSON.parse(await restoreRagDb({ projectKey: 'other-project', project: fixture.root }, fixture.root));
        expect({ result, ids: await ids(), requests: transport.fetch.mock.calls.length }).toMatchObject({
            result: { ok: false, error: 'project-instance-unverified' }, ids: ['local-original'], requests: 0,
        });
    });

    it('Настройка vectorStore за пределами подтверждённой папки не разрешает перезапись чужого индекса', async () => {
        const outside = path.join(fixture.temporary, 'outside/rag_db');
        await writeRows(outside, [row('outside-original')], false, 3);
        await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ vectorStore: { path: outside } }));
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root)).rejects.toThrow('внутри');
        expect(await ids(outside)).toEqual(['outside-original']);
        expect(transport.fetch).not.toHaveBeenCalled();
    });

    it('Подтверждённый экземпляр получает серверные строки и только затем зеркальный cleanup', async () => {
        transport.fetch.mockImplementation(async () => page(['restored-a', 'restored-b']));
        const result = JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root));
        expect(result).toMatchObject({ ok: true, written: 2, deleted: 1, sourceCount: 2 });
        expect(await ids()).toEqual(['restored-a', 'restored-b']);
    });

    it('Новая проверка экземпляра сохраняет поддержку относительного project от cwd', async () => {
        const result = JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: path.basename(fixture.root) }, path.dirname(fixture.root)));
        expect(result).toMatchObject({ ok: true, written: 1, deleted: 1 });
        expect(await ids()).toEqual(['server-row']);
    });

    it('Симлинк на внешний индекс блокируется до скачивания', async () => {
        const outside = path.join(fixture.temporary, 'outside-index');
        await writeRows(outside, [row('outside-original')], false, 3);
        await fs.rm(store, { recursive: true });
        await fs.symlink(outside, store, 'dir');
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root)).rejects.toThrow('симлинк');
        expect(await ids(outside)).toEqual(['outside-original']);
        expect(transport.fetch).not.toHaveBeenCalled();
    });

    it.each(['missing', 'legacy'])('Отсутствующая или старая привязка %s запрещает скачивание до HTTP и локальной записи', async mode => {
        const marker = path.join(fixture.root, '.opencode/neurocenter.json');
        if (mode === 'missing') { await fs.rm(marker); }
        else { await fs.writeFile(marker, JSON.stringify({ version: 1, server: 'http://localhost:5173', projectId: 'test-project' })); }
        expect(JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root))).toMatchObject({ ok: false, error: 'project-instance-unverified' });
        expect(await ids()).toEqual(['local-original']);
        expect(transport.fetch).not.toHaveBeenCalled();
    });

    it('Копия marker в другой физической папке не получает право на замену индекса', async () => {
        const copy = path.join(fixture.temporary, 'copied');
        await fs.cp(fixture.root, copy, { recursive: true });
        expect(JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: copy }, copy))).toMatchObject({ ok: false, error: 'project-instance-unverified' });
        expect(await ids(path.join(copy, '.opencode/rag_db'))).toEqual(['local-original']);
        expect(transport.fetch).not.toHaveBeenCalled();
    });

    it('Подмена projectKey в ответе сервера отклоняется до первой записи', async () => {
        transport.fetch.mockImplementation(async () => page(['foreign-row'], false, 'other-project'));
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root)).rejects.toThrow('другого проекта');
        expect(await ids()).toEqual(['local-original']);
    });

    it('Смена поколения при получении первой страницы не меняет локальный индекс', async () => {
        transport.fetch.mockImplementation(async () => { await changeGeneration(); return page(['foreign-row']); });
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root)).rejects.toThrow('экземпляра изменилась');
        expect(await ids()).toEqual(['local-original']);
    });

    it('Смена bindingNonce между страницами сохраняет подтверждённую порцию и запрещает следующую запись и cleanup', async () => {
        transport.fetch.mockImplementationOnce(async () => page(['first-page'], true)).mockImplementationOnce(async () => {
            await changeGeneration(); return page(['second-page']);
        });
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root)).rejects.toThrow('экземпляра изменилась');
        expect(await ids()).toEqual(['first-page', 'local-original']);
        expect(transport.fetch).toHaveBeenCalledTimes(2);
    });

    it('Смена поколения после последней записи не разрешает удалить исходные строки', async () => {
        const write = lance.writeRows;
        vi.spyOn(lance, 'writeRows').mockImplementation(async (...args) => { const result = await write(...args); await changeGeneration(); return result; });
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root)).rejects.toThrow('экземпляра изменилась');
        expect(await ids()).toEqual(['local-original', 'server-row']);
    });

    it('Отказ второй страницы не удаляет исходный индекс, повтор завершает mirror без дублей', async () => {
        transport.fetch.mockImplementationOnce(async () => page(['first-page'], true)).mockImplementationOnce(async () => new Response('<html>internal-secret</html>', { status: 503 }));
        const result = JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root));
        expect(result).toMatchObject({ ok: false, error: 'chunks 503', written: 1 });
        expect(result.message).toContain('Ранее записано фрагментов: 1');
        expect(result.message).not.toContain('internal-secret');
        expect(await ids()).toEqual(['first-page', 'local-original']);
        transport.fetch.mockImplementation(async () => page(['first-page', 'second-page']));
        expect(JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root))).toMatchObject({ ok: true, sourceCount: 2, deleted: 1 });
        expect(await ids()).toEqual(['first-page', 'second-page']);
    });

    it.each([false, true])('Пустая страница hasMore=%s не очищает исходные данные', async hasMore => {
        transport.fetch.mockImplementation(async () => page([], hasMore));
        expect(JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root))).toMatchObject({ ok: false, error: hasMore ? 'incomplete-source' : 'empty-source' });
        expect(await ids()).toEqual(['local-original']);
    });

    it('Смена vectorStore в конфиге при скачивании не перенаправляет запись', async () => {
        const other = path.join(fixture.root, '.opencode/other-index');
        await writeRows(other, [row('other-original')], false, 3);
        transport.fetch.mockImplementation(async () => {
            await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ vectorStore: { path: other } }));
            return page(['server-row']);
        });
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root)).rejects.toThrow('Путь локального индекса изменился');
        expect(await ids()).toEqual(['local-original']);
        expect(await ids(other)).toEqual(['other-original']);
    });
});
