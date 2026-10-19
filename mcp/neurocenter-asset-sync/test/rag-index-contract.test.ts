import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locateStore, RAG_CONFIG_PATHS } from '../src/lib/store.js';
import { openIndexSnapshot } from '../src/features/rag-index/snapshot.js';
import { localIndexProfile } from '../src/features/rag-index/readiness.js';
import { writeRows } from '../src/lib/lancedb.js';
import { workspaceFixture } from './bridge-fixture.js';
import { row } from './rag-index-fixture.js';
import { stateDir } from '../src/bridge/state.js';

describe('Контракт путей native OpenCodeRAG и стабильного LanceDB', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    beforeEach(async () => { fixture = await workspaceFixture(); await fs.mkdir(path.join(fixture.root, '.opencode'), { recursive: true }); });
    afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    it.each(RAG_CONFIG_PATHS)('Читает %s и разрешает vectorStore.path от корня проекта', async name => {
        await fs.writeFile(path.join(fixture.root, name), JSON.stringify({ vectorStore: { path: './knowledge-index' } }));
        await fs.mkdir(path.join(fixture.root, '.opencode/rag_db'));
        expect(await locateStore(fixture.root, fixture.root)).toMatchObject({ root: fixture.root, configPath: path.join(fixture.root, name), storePath: path.join(fixture.root, 'knowledge-index') });
    });
    it('Приоритет трёх конфигов совпадает с native; соседний устаревший индекс не выбирается', async () => {
        for (const [index, name] of RAG_CONFIG_PATHS.entries()) { await fs.writeFile(path.join(fixture.root, name), JSON.stringify({ vectorStore: { path: './index-' + index } })); }
        expect((await locateStore(fixture.root, fixture.root)).storePath).toBe(path.join(fixture.root, 'index-0'));
    });
    it('Повреждённый приоритетный конфиг не переключает передачу на другой индекс', async () => {
        await fs.writeFile(path.join(fixture.root, RAG_CONFIG_PATHS[0]!), '{');
        await expect(locateStore(fixture.root, fixture.root)).rejects.toThrow('повреждена');
    });
    it('Нельзя вывести название модели только по размерности 2560', async () => {
        const located = await locateStore(fixture.root, fixture.root);
        await expect(localIndexProfile(located, 2560)).rejects.toThrow('не подтверждён');
    });
    it('Автономный native-плагин с пустым receipt.files задаёт закреплённый default без записи конфига', async () => {
        const directory = path.join(fixture.root, '.opencode/neurocenter/receipts'); await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'a'.repeat(24) + '.json'), JSON.stringify({ version: 4, manifest: 'b'.repeat(64), files: {},
            config: { path: 'opencode.json', key: 'plugin', value: pathToFileURL(path.join(stateDir(), 'runtime-artifacts', 'c'.repeat(64), 'rag-plugin.mjs')).href } }));
        expect(await localIndexProfile(await locateStore(fixture.root, fixture.root), 2560)).toEqual({ provider: 'ollama', model: 'qwen3-embedding:4b', dimension: 2560 });
        await expect(fs.stat(path.join(fixture.root, 'opencode-rag.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        const partial = JSON.stringify({ vectorStore: { path: './custom-index' }, openCode: { autoIndex: { enabled: false } } });
        const config = path.join(fixture.root, 'opencode-rag.json'); await fs.writeFile(config, partial);
        expect(await localIndexProfile(await locateStore(fixture.root, fixture.root), 2560)).toEqual({ provider: 'ollama', model: 'qwen3-embedding:4b', dimension: 2560 });
        expect(await fs.readFile(config, 'utf8')).toBe(partial);
        await fs.writeFile(config, JSON.stringify({ embedding: { provider: 'ollama', model: 'explicit-custom', baseUrl: 'http://127.0.0.1:9988/api', vectorDimension: 3 } }));
        expect(await localIndexProfile(await locateStore(fixture.root, fixture.root), 3)).toEqual({ provider: 'ollama', model: 'explicit-custom', dimension: 3 });
    });
    it('Эффективная runtime-модель имеет тот же приоритет, что и у native', async () => {
        const store = path.join(fixture.root, '.opencode/rag_db'); await fs.mkdir(store);
        await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ embedding: { provider: 'ollama', model: 'base', vectorDimension: 3 } }));
        await fs.writeFile(path.join(store, 'runtime-overrides.json'), JSON.stringify({ embedding: { model: 'overridden' } }));
        expect(await localIndexProfile(await locateStore(fixture.root, fixture.root), 3)).toEqual({ provider: 'ollama', model: 'overridden', dimension: 3 });
    });
    it('Pinned checkout не пропускает недостающий ID и замечает изменение текущей версии', async () => {
        const store = path.join(fixture.root, '.opencode/rag_db'); await writeRows(store, [row('a')], false, 3);
        const snapshot = await openIndexSnapshot(store);
        try {
            await expect(snapshot.selected(['a', 'missing'])).rejects.toThrow('Не все');
            await writeRows(store, [row('b')], false, 3);
            const values = []; for await (const value of snapshot.rows()) { values.push(value.id); }
            expect(values).toEqual(['a']); await expect(snapshot.assertCurrent()).rejects.toThrow('изменился');
        } finally { snapshot.close(); }
    });
});
