import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import { validateBuiltinManifest } from '../src/builtin-catalog/manifest';
import { builtinCardHash, BuiltinCatalogConflict, planBuiltinTool, type IBuiltinReceipt } from '../src/builtin-catalog/planning';
import { cacheBuiltinArtifacts } from '../src/builtin-catalog/download';
import { syncBuiltinCatalog } from '../src/builtin-catalog/sync';
import { PluginRepository } from '../src/publication/plugin-repository';
import { RuntimeArtifacts } from '../src/runtime-artifacts/runtime-artifacts';
import { publicationHash } from '../src/publication/publication-validation';
import type { IAiPlugin } from '../src/catalog/dto';
import { BuiltinCatalogFailure, builtinCatalogError, builtinCatalogWarnings } from '../src/builtin-catalog/diagnostics';

const { archive, descriptor } = artifactFixture();
const release = 'catalog-2026-10-19.1';
const rawTool = { key: 'memory', publication: { name: 'MCP Memory', kind: 'mcp' as const, description: 'Готовый MCP',
    origin: 'npm:@modelcontextprotocol/server-memory', revision: '1.0.0-pack.1',
    config: { transport: 'stdio' as const, extra: { runtimeArtifacts: [descriptor] } } },
    legacyOrigins: ['upload', 'npm:@modelcontextprotocol/server-memory'], legacyPackages: ['@modelcontextprotocol/server-memory'],
    artifacts: [{ descriptor, url: `https://github.com/ghost-raven1/neurocenter/releases/download/${release}/${descriptor.sha256}.tar.gz` }] };
const input = (tools = [rawTool]) => ({ schemaVersion: 1, release, tools });
const tool = () => validateBuiltinManifest(input()).tools[0];
const card = (overrides: Partial<IAiPlugin> = {}): IAiPlugin => ({
    id: 'ai-plug-existing', name: rawTool.publication.name, kind: 'mcp', version: 1, description: 'Моё описание', tags: ['Мой тег'],
    origin: 'upload', revision: null, compatibility: null, files: [], createdAt: 'then', updatedAt: 'then',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, ...overrides,
});
const receipt = (current: IAiPlugin): IBuiltinReceipt => ({ tool_key: 'memory', asset_id: current.id, release,
    publication_hash: publicationHash(tool().publication), card_hash: builtinCardHash(current) });
const roots: string[] = [];
async function directory() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-builtin-catalog-')); roots.push(root); return root;
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); } });

describe('Проверка доверенной поставки встроенного каталога', () => {
    it('Принимает точные descriptors и допускает повторную проверку нормализованного manifest', () => {
        const checked = validateBuiltinManifest(input());
        expect(validateBuiltinManifest(checked)).toEqual(checked);
        expect(checked.tools[0].publication).not.toHaveProperty('publicationKey');
    });
    it.each([
        'https://example.test/runtime.tar.gz',
        `https://github.com/other/repo/releases/download/${release}/${descriptor.sha256}.tar.gz`,
        `https://github.com/ghost-raven1/neurocenter/releases/download/other/${descriptor.sha256}.tar.gz`,
        `https://github.com/ghost-raven1/neurocenter/releases/download/${release}/${descriptor.sha256}.tar.gz?token=private`,
    ])('Не доверяет URL вне точного release: %s', url => {
        expect(() => validateBuiltinManifest(input([{ ...rawTool, artifacts: [{ descriptor, url }] }]))).toThrow(/GitHub release/);
    });
    it('Повреждённый второй инструмент останавливает проверку до сети, файлов и БД', async () => {
        const request = vi.fn();
        await expect(syncBuiltinCatalog(input([rawTool, { ...rawTool, key: 'other' }]), { downloadOnly: true, fetch: request }))
            .rejects.toThrow(/уникальными/);
        expect(request).not.toHaveBeenCalled();
    });
    it('Несовпадающий descriptor, плавающая ревизия и ключ публикации отвергаются', () => {
        expect(() => validateBuiltinManifest(input([{ ...rawTool, artifacts: [{ ...rawTool.artifacts[0], descriptor: { ...descriptor, entrypoint: 'other.mjs' } }] }]))).toThrow(/не совпадают/);
        expect(() => validateBuiltinManifest(input([{ ...rawTool, publication: { ...rawTool.publication, revision: 'main' } }]))).toThrow(/закреплёнными/);
        expect(() => validateBuiltinManifest(input([{ ...rawTool, publication: { ...rawTool.publication, publicationKey: 'private' } } as never]))).toThrow(/публикацию/);
        expect(() => validateBuiltinManifest({ ...input(), release: 'latest' })).toThrow(/закреплённый release/);
    });
    it('Dry-run не требует БД и не скачивает архивы', async () => {
        const request = vi.fn();
        expect(await syncBuiltinCatalog(input(), { dryRun: true, fetch: request })).toMatchObject({ ok: true, dryRun: true, release });
        expect(request).not.toHaveBeenCalled();
    });
});

describe('План миграции существующих карточек без потери настроек', () => {
    it.each([
        { args: ['@modelcontextprotocol/server-memory'] }, { args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'] },
        { args: ['--yes', '@modelcontextprotocol/server-memory'] },
        { args: ['-y', '@modelcontextprotocol/server-memory@latest'] },
        { args: ['@modelcontextprotocol/server-memory@next'] },
        { args: ['@modelcontextprotocol/server-memory@^1.0.0'] },
        { args: ['@modelcontextprotocol/server-memory@>=1.0.0 <2.0.0'] },
    ])('Узнаёт старый npx с единственным известным пакетом: $args', ({ args }) => {
        const plan = planBuiltinTool(tool(), card({ config: { transport: 'stdio', command: 'npx', args } }));
        expect(plan.action).toBe('update'); expect(plan.patch).toMatchObject({ expectedVersion: 1, config: tool().publication.config });
        expect(plan.patch).not.toHaveProperty('description'); expect(plan.patch).not.toHaveProperty('tags'); expect(plan.patch).not.toHaveProperty('dependencies');
    });
    it.each([
        { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory', '--custom'] },
        { command: 'npx', args: ['unknown-package'] },
        { command: 'npx', args: ['@modelcontextprotocol/server-memory@https://unknown.test/file.tgz'] },
        { command: 'uvx', args: ['@modelcontextprotocol/server-memory'] },
        { command: 'node', env: { CUSTOM: 'my-value' } },
        { command: 'node', extra: { localConfiguration: { custom: true } } },
        { transport: 'remote' as const, url: 'https://example.test/mcp' },
    ])('Не перезаписывает собственную команду или настройку: %j', config => {
        expect(() => planBuiltinTool(tool(), card({ config }))).toThrow(/изменена пользователем/);
    });
    it('Чужой источник, иной тип и собственные файлы останавливают усыновление старой карточки', () => {
        for (const overrides of [{ origin: 'unknown' }, { kind: 'plugin' as const }, { files: [{ path: 'own.mjs', content: 'private', size: 7, digest: 'own' }] }]) {
            expect(() => planBuiltinTool(tool(), card(overrides))).toThrow(/источник не подтверждён/);
        }
    });
    it('Готовая собственная сборка с тем же источником не заменяется; точное совпадение принимается без новой версии', () => {
        const custom = card({ config: { transport: 'stdio', command: 'node', entrypoint: 'custom.mjs',
            extra: { runtimeArtifacts: [{ ...descriptor, entrypoint: 'custom.mjs' }] } }, revision: 'my-own-build' });
        expect(() => planBuiltinTool(tool(), custom)).toThrow(/источник не подтверждён/);
        expect(planBuiltinTool(tool(), card({ config: tool().publication.config ?? null, revision: tool().publication.revision ?? null })).action)
            .toBe('unchanged');
    });
    it('Повтор той же поставки не создаёт версию, но пользовательская правка после неё даёт конфликт', () => {
        const current = card({ config: tool().publication.config ?? null, revision: tool().publication.revision ?? null });
        const managed = receipt(current);
        expect(planBuiltinTool(tool(), current, managed).action).toBe('unchanged');
        expect(() => planBuiltinTool(tool(), { ...current, description: 'Изменено после поставки' }, managed)).toThrow(/изменена пользователем/);
        expect(() => planBuiltinTool(tool(), null, managed)).toThrow(/изменена пользователем/);
    });
});

describe('Неизменяемый кеш готовых архивов', () => {
    it('Предзагрузка проверяет настоящий архив без БД, повтор сохраняет inode и не ходит в сеть', async () => {
        const root = await directory(); vi.stubEnv('RUNTIME_ARTIFACT_DIR', root);
        const request = vi.fn(async () => new Response(archive));
        expect(await syncBuiltinCatalog(input(), { downloadOnly: true, fetch: request as typeof fetch }))
            .toMatchObject({ downloadOnly: true, artifacts: 1 });
        const filename = path.join(root, descriptor.sha256 + '.tar.gz'), before = await fs.stat(filename);
        await cacheBuiltinArtifacts(tool().artifacts, root, request as typeof fetch);
        expect((await fs.stat(filename)).ino).toBe(before.ino); expect(request).toHaveBeenCalledOnce();
        expect(await fs.readdir(root)).toEqual([descriptor.sha256 + '.tar.gz']);
    });
    it.each(['short', 'oversize', 'sha'] as const)('Прерывает загрузку с ошибкой %s до появления готового файла', async failure => {
        const root = await directory();
        const bytes = failure === 'short' ? archive.subarray(0, 3) : failure === 'oversize' ? Buffer.concat([archive, Buffer.from('extra')]) : Buffer.alloc(archive.length);
        const request = vi.fn(async () => new Response(bytes));
        await expect(cacheBuiltinArtifacts(tool().artifacts, root, request as typeof fetch)).rejects.toThrow(/размер|SHA-256/);
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('Не заменяет повреждённый файл под существующим SHA', async () => {
        const root = await directory(), filename = path.join(root, descriptor.sha256 + '.tar.gz');
        await fs.writeFile(filename, Buffer.alloc(archive.length)); const request = vi.fn();
        await expect(cacheBuiltinArtifacts(tool().artifacts, root, request)).rejects.toThrow(/SHA-256/);
        expect(request).not.toHaveBeenCalled(); expect(await fs.readFile(filename)).toEqual(Buffer.alloc(archive.length));
    });
    it('Обрыв ответа после заголовков получает безопасную причину и не оставляет готовый архив', async () => {
        const root = await directory();
        const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('https://private:secret@host')); } });
        const request = vi.fn(async () => new Response(stream));
        let failure: unknown;
        try { await cacheBuiltinArtifacts(tool().artifacts, root, request as typeof fetch); }
        catch (error) { failure = error; }
        expect(builtinCatalogError(failure)).toContain('Загрузка готового комплекта прервана');
        expect(builtinCatalogError(failure)).not.toContain('secret');
        expect(await fs.readdir(root)).toEqual([]);
    });
});

describe('Все подготовленные конфликты останавливают публикацию до карточек', () => {
    it('Конфликт второй карточки не создаёт первую и не скачивает архивы', async () => {
        const query = vi.fn(async () => ({ rows: [] })), lease = { query, release: vi.fn() };
        const pool = { query, connect: async () => lease } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockImplementation(async name => name === 'Other MCP' ? card({ name: 'Other MCP', origin: 'untrusted' }) : null);
        const create = vi.spyOn(PluginRepository.prototype, 'create'), update = vi.spyOn(PluginRepository.prototype, 'update'), request = vi.fn();
        const second = { ...rawTool, key: 'other', publication: { ...rawTool.publication, name: 'Other MCP' } };
        await expect(syncBuiltinCatalog(input([rawTool, second]), { pool, fetch: request })).rejects.toThrow(/источник не подтверждён/);
        expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
        expect(lease.release).toHaveBeenCalledOnce();
    });
    it('Сбой импорта архива не создаёт карточку', async () => {
        const root = await directory(); vi.stubEnv('RUNTIME_ARTIFACT_DIR', root);
        const query = vi.fn(async () => ({ rows: [] }));
        const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockResolvedValue(null);
        const create = vi.spyOn(PluginRepository.prototype, 'create');
        vi.spyOn(RuntimeArtifacts.prototype, 'importArchive').mockRejectedValue(new Error('Реестр недоступен'));
        await expect(syncBuiltinCatalog(input(), { pool, fetch: vi.fn(async () => new Response(archive)) as typeof fetch })).rejects.toThrow('Реестр недоступен');
        expect(create).not.toHaveBeenCalled();
    });
    it('Весь выпуск использует одну внешнюю транзакцию, отказ второй карточки откатывает первую', async () => {
        const root = await directory(); vi.stubEnv('RUNTIME_ARTIFACT_DIR', root);
        const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT compressed_bytes') ? [{
            compressed_bytes: descriptor.compressedBytes, unpacked_bytes: descriptor.unpackedBytes, files_count: descriptor.filesCount,
        }] : [] }));
        const lease = { query, release: vi.fn() } as unknown as PoolClient;
        const pool = { query, connect: async () => lease } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockResolvedValue(null);
        const importer = vi.spyOn(RuntimeArtifacts.prototype, 'importArchive');
        const create = vi.spyOn(PluginRepository.prototype, 'create').mockImplementation(async (publication, _author, finish, client, inTransaction) => {
            expect(client).toBe(lease); expect(inTransaction).toBe(true);
            if (publication.name === 'Other MCP') { throw new Error('Вторая карточка не сохранена'); }
            const published = card({ config: publication.config ?? null }); await finish?.(client!, published); return published;
        });
        const second = { ...rawTool, key: 'other', publication: { ...rawTool.publication, name: 'Other MCP' } };
        await expect(syncBuiltinCatalog(input([rawTool, second]), { pool, fetch: vi.fn(async () => new Response(archive)) as typeof fetch }))
            .rejects.toThrow('Вторая карточка не сохранена');
        expect(create).toHaveBeenCalledTimes(2); expect(importer).not.toHaveBeenCalled();
        expect(query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(1);
        expect(query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(query.mock.calls.some(([sql]) => sql.endsWith('ORDER BY id FOR UPDATE'))).toBe(true);
    });
});

describe('Частичное обновление встроенного каталога при запуске разработки', () => {
    it('Пропускает изменённую карточку и её архив, остальные карточки записывает одной транзакцией', async () => {
        const root = await directory(); vi.stubEnv('RUNTIME_ARTIFACT_DIR', root);
        const otherFixture = artifactFixture([{ path: 'runtime/other.mjs', content: 'export const other = true;' }]);
        const conflicting = { ...rawTool, key: 'other', publication: { ...rawTool.publication, name: 'Other MCP',
            config: { transport: 'stdio' as const, extra: { runtimeArtifacts: [otherFixture.descriptor] } } },
        artifacts: [{ descriptor: otherFixture.descriptor, url: `https://github.com/ghost-raven1/neurocenter/releases/download/${release}/${otherFixture.descriptor.sha256}.tar.gz` }] };
        const query = vi.fn(async () => ({ rows: [] })), lease = { query, release: vi.fn() };
        const pool = { query, connect: async () => lease } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockImplementation(async name => name === 'Other MCP' ? card({ name: 'Other MCP', origin: 'untrusted' }) : null);
        const create = vi.spyOn(PluginRepository.prototype, 'create').mockImplementation(async (publication, _author, finish, client) => {
            const saved = card({ name: publication.name, config: publication.config ?? null });
            await finish?.(client!, saved); return saved;
        });
        const update = vi.spyOn(PluginRepository.prototype, 'update'), importer = vi.spyOn(RuntimeArtifacts.prototype, 'importArchive').mockResolvedValue({} as never);
        const request = vi.fn(async () => new Response(archive));
        const result = await syncBuiltinCatalog(input([rawTool, conflicting]), { pool, skipConflicts: true, fetch: request as typeof fetch });
        expect(result).toMatchObject({ ok: true, dryRun: false, partial: true, conflicts: [{ key: 'other', name: 'Other MCP', reason: expect.stringContaining('изменена пользователем') }],
            tools: [{ key: 'memory', action: 'create' }] });
        expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][0]).toBe(rawTool.artifacts[0].url);
        expect(importer).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce(); expect(update).not.toHaveBeenCalled();
        expect(query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(1);
        expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
        expect(query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO builtin_catalog_receipts'))).toHaveLength(1);
    });

    it('Если все карточки конфликтуют, не скачивает архивы и не меняет карточки или квитанции', async () => {
        const query = vi.fn(async () => ({ rows: [] }));
        const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockResolvedValue(card({ origin: 'untrusted' }));
        const create = vi.spyOn(PluginRepository.prototype, 'create'), update = vi.spyOn(PluginRepository.prototype, 'update'), request = vi.fn();
        const result = await syncBuiltinCatalog(input(), { pool, skipConflicts: true, fetch: request });
        expect(result).toMatchObject({ ok: true, partial: true, conflicts: [{ key: 'memory' }], tools: [] });
        expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO builtin_catalog_receipts'))).toBe(false);
    });

    it('Изменение карточки во время подготовки пропускается без записи квитанции', async () => {
        const root = await directory(); vi.stubEnv('RUNTIME_ARTIFACT_DIR', root);
        const query = vi.fn(async () => ({ rows: [] }));
        const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockResolvedValueOnce(card()).mockResolvedValue(card({ description: 'Конкурентная правка' }));
        vi.spyOn(RuntimeArtifacts.prototype, 'importArchive').mockResolvedValue({} as never);
        const update = vi.spyOn(PluginRepository.prototype, 'update');
        const result = await syncBuiltinCatalog(input(), { pool, skipConflicts: true, fetch: vi.fn(async () => new Response(archive)) as typeof fetch });
        expect(result).toMatchObject({ partial: true, conflicts: [{ reason: expect.stringContaining('во время подготовки') }], tools: [] });
        expect(update).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO builtin_catalog_receipts'))).toBe(false);
    });

    it('Карточка с другим регистром названия обнаруживается до создания дубликата', async () => {
        const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT id FROM ai_plugins WHERE lower(name)') ? [{ id: 'ai-plug-existing' }] : [] }));
        const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockImplementation(async key => key === 'ai-plug-existing' ? card({ name: 'mcp memory', origin: 'untrusted' }) : null);
        const create = vi.spyOn(PluginRepository.prototype, 'create'), request = vi.fn();
        const result = await syncBuiltinCatalog(input(), { pool, skipConflicts: true, fetch: request });
        expect(result).toMatchObject({ partial: true, conflicts: [{ key: 'memory' }], tools: [] });
        expect(create).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    });

    it('Не скрывает сбой БД под видом пользовательского конфликта', async () => {
        const query = vi.fn(async () => ({ rows: [] }));
        const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockRejectedValue(new Error('База недоступна'));
        await expect(syncBuiltinCatalog(input(), { pool, skipConflicts: true })).rejects.toThrow('База недоступна');
    });

    it('Пропуск конфликтов не скрывает сетевой отказ и несовместим с режимами без записи', async () => {
        const root = await directory(); vi.stubEnv('RUNTIME_ARTIFACT_DIR', root);
        const query = vi.fn(async () => ({ rows: [] }));
        const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
        vi.spyOn(PluginRepository.prototype, 'get').mockResolvedValue(null);
        const create = vi.spyOn(PluginRepository.prototype, 'create');
        await expect(syncBuiltinCatalog(input(), { pool, skipConflicts: true, fetch: vi.fn().mockRejectedValue(new Error('Сеть недоступна')) })).rejects.toThrow('сеть недоступна');
        expect(create).not.toHaveBeenCalled();
        for (const option of [{ dryRun: true }, { downloadOnly: true }]) {
            await expect(syncBuiltinCatalog(input(), { ...option, skipConflicts: true })).rejects.toThrow('только при обновлении');
        }
    });

    it('Диагностика показывает конфликт и код БД, сохраняя строки подключения и параметры в тайне', () => {
        const conflict = new BuiltinCatalogConflict(tool(), 'собственная настройка требует проверки.');
        expect(builtinCatalogError(conflict)).toContain('Встроенный каталог: «MCP Memory»');
        expect(builtinCatalogWarnings([conflict.conflict])[0]).toContain('npm run tools:sync');
        const output = builtinCatalogError(Object.assign(new Error('postgresql://user:private@host/db'), { code: '28P01' }));
        expect(output).toContain('28P01'); expect(output).not.toContain('private'); expect(output).not.toContain('postgresql:');
        expect(builtinCatalogError(new Error('https://private:secret@host'))).not.toContain('secret');
        expect(builtinCatalogError(new BuiltinCatalogFailure('Не удалось скачать готовый комплект (HTTP 404).'))).toContain('HTTP 404');
    });
});

describe('Квитанция обновления входит в транзакцию репозитория', () => {
    it('Отказ записи квитанции откатывает версию и аудит, включая заимствованного клиента', async () => {
        const current = card({ config: { transport: 'remote', url: 'https://example.test/mcp' } });
        const row = { ...current, created_at: 'then', updated_at: 'then', dependencies: [] };
        const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
            if (sql.startsWith('SELECT * FROM ai_plugins')) { return { rows: [row] }; }
            if (sql.startsWith('SELECT GREATEST')) { return { rows: [{ v: 2 }] }; }
            if (sql.startsWith('UPDATE ai_plugins')) { return { rows: [{ ...row, version: 2, description: parameters![1] }] }; }
            return { rows: [] };
        });
        const client = { query, release: vi.fn() } as unknown as PoolClient, connect = vi.fn();
        const repository = new PluginRepository({ connect } as unknown as Pool);
        await expect(repository.update(current.id, { expectedVersion: 1, description: 'Обновлено' }, 'builtin-catalog', async () => {
            throw new Error('Квитанция не сохранена');
        }, client)).rejects.toThrow('Квитанция не сохранена');
        expect(connect).not.toHaveBeenCalled(); expect(client.release).not.toHaveBeenCalled();
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO security_events'))).toBe(true);
    });
    it('Внешняя транзакция остаётся у владельца при успешной записи и при отказе квитанции', async () => {
        const current = card({ config: { transport: 'remote', url: 'https://example.test/mcp' } });
        const row = { ...current, created_at: 'then', updated_at: 'then', dependencies: [] };
        for (const failure of [false, true]) {
            const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM ai_plugins') ? [row] : [] }));
            const client = { query, release: vi.fn() } as unknown as PoolClient;
            const repository = new PluginRepository({ connect: vi.fn() } as unknown as Pool);
            const finish = vi.fn(async () => { if (failure) { throw new Error('Контролируемый отказ'); } });
            const update = repository.update(current.id, { expectedVersion: 1, description: current.description }, 'builtin-catalog', finish, client, true);
            if (failure) { await expect(update).rejects.toThrow('Контролируемый отказ'); }
            else { await expect(update).resolves.toMatchObject({ id: current.id }); }
            expect(finish).toHaveBeenCalledOnce(); expect(client.release).not.toHaveBeenCalled();
            expect(query.mock.calls.some(([sql]) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))).toBe(false);
        }
    });
});
