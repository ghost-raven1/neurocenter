import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { validatePublication } from '../src/publication/publication-validation';
import { PluginRepository } from '../src/publication/plugin-repository';
import { buildPackage } from '../src/catalog/bundle-package';
import { assertInstallablePackage } from '../src/devices/installation-set';
import { assertPublicationDependencies } from '../src/publication/publication-dependencies';

const input = { name: 'Локальный помощник', kind: 'mcp', description: 'Проверка ручной публикации' };

describe('Ручная публикация не создаёт недоставляемую внешнюю команду MCP', () => {
    it.each([
        { command: 'npx', args: ['-y', 'fixture@1.0.0'] },
        { command: 'node', args: ['/Users/operator/private/server.js'] },
        { command: '/usr/local/bin/mcp', args: [] },
    ])('Отклоняет команду без закреплённых файлов до сохранения: %j', config => {
        expect(() => validatePublication({ ...input, config: { transport: 'stdio', ...config } }))
            .toThrow(/Упаковать инструмент/);
    });

    it('Обычная внешняя команда действительно не проходит существующий delivery-контракт', () => {
        const pkg = buildPackage({ id: 'ai-plug-fixture', name: input.name, kind: 'mcp', version: 1 }, [], '',
            { transport: 'stdio', command: 'npx', args: ['-y', 'fixture@1.0.0'] });
        expect(() => assertInstallablePackage(pkg)).toThrow('Внешняя команда MCP не входит в закреплённый пакет');
    });

    it('Некорректная новая публикация не открывает транзакцию и не записывает карточку', async () => {
        const connect = vi.fn();
        const repository = new PluginRepository({ connect } as unknown as Pool);
        await expect(repository.create({ ...input, kind: 'mcp', config: { transport: 'stdio', command: 'npx' } }, 'qa@example.test'))
            .rejects.toMatchObject({ status: 400 });
        expect(connect).not.toHaveBeenCalled();
    });

    it('Новая публикация не наследует недоставляемую внешнюю команду из исторической зависимости', async () => {
        const dependency = { id: 'ai-plug-legacy', name: 'Старая команда', kind: 'mcp', files: [],
            config: { transport: 'stdio' as const, command: 'npx', args: ['fixture@1.0.0'] }, metadata: { kind: 'mcp' } };
        const pkg = buildPackage({ id: dependency.id, name: dependency.name, kind: 'mcp', version: 1 }, [], '', dependency.config);
        const query = vi.fn(async () => ({ rows: [dependency] }));
        await expect(assertPublicationDependencies({ query } as unknown as PoolClient,
            [{ kind: 'mcp', id: dependency.id, version: 1, manifest: pkg.manifest.sha256 }])).rejects.toMatchObject({ status: 409 });
    });

    it.each([
        { config: { transport: 'remote', url: 'https://example.test/mcp' } },
        { config: { transport: 'stdio', command: 'node', entrypoint: 'server.mjs' }, files: [{ path: 'server.mjs', content: 'export default {}' }] },
        { config: { transport: 'stdio', extra: { runtimeArtifacts: [{ target: 'darwin-arm64', sha256: 'a'.repeat(64), compressedBytes: 100,
            unpackedBytes: 200, filesCount: 2, entrypoint: 'runtime/server.mjs' }] } } },
    ])('Сохраняет устанавливаемые варианты: %j', source => {
        const publication = validatePublication({ ...input, ...source });
        const pkg = buildPackage({ id: 'ai-plug-fixture', name: publication.name, kind: 'mcp', version: 1 },
            publication.files!.map(file => ({ path: file.path, content: file.content! })), '', publication.config);
        expect(() => assertInstallablePackage(pkg)).not.toThrow();
    });
});

describe('Старая внешняя команда остаётся доступной для очистки или исправления', () => {
    const legacy = { id: 'ai-plug-legacy', ...input, version: 1, compatibility: null, tags: [], origin: 'upload', revision: null,
        config: { transport: 'stdio', command: 'npx' }, files: [], dependencies: [], created_at: '', updated_at: '' };
    const fixture = () => {
        const query = vi.fn(async (sql: string, params?: unknown[]) => {
            if (sql.startsWith('SELECT * FROM ai_plugins WHERE')) { return { rows: [legacy] }; }
            if (sql.startsWith('SELECT GREATEST')) { return { rows: [{ v: 2 }] }; }
            if (sql.startsWith('UPDATE ai_plugins')) { return { rows: [{ ...legacy, version: 2, config: JSON.parse(String(params![7])), files: JSON.parse(String(params![8])) }] }; }
            return { rows: [] };
        });
        const repository = new PluginRepository({ query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool, async () => undefined);
        return { repository, query };
    };

    it('Чтение и удаление старой карточки не требуют новой публикационной валидации', async () => {
        const { repository } = fixture();
        await expect(repository.get(legacy.id)).resolves.toMatchObject({ id: legacy.id, config: legacy.config });
        await expect(repository.delete(legacy.id, 'qa@example.test')).resolves.toBe(true);
    });

    it.each([{}, { config: legacy.config, files: legacy.files }, { description: legacy.description }])(
        'Точный повтор старой карточки не создаёт версию или аудит: %j', async changes => {
            const { repository, query } = fixture();
            await expect(repository.update(legacy.id, { ...changes, expectedVersion: 1 }, 'qa@example.test'))
                .resolves.toMatchObject({ id: legacy.id, version: 1, config: legacy.config });
            expect(query.mock.calls.some(([sql]) => /^(INSERT INTO|UPDATE|DELETE FROM) /.test(sql))).toBe(false);
        },
    );

    it('Точный повтор не обходит конфликт текущей версии', async () => {
        const { repository } = fixture();
        await expect(repository.update(legacy.id, { expectedVersion: 2 }, 'qa@example.test'))
            .rejects.toMatchObject({ status: 409 });
    });

    it('Точный повтор не разрешает неизвестные поля запроса', async () => {
        const { repository, query } = fixture();
        const update = { expectedVersion: 1, unknown: true };
        await expect(repository.update(legacy.id, update, 'qa@example.test')).rejects.toMatchObject({ status: 400 });
        expect(query).not.toHaveBeenCalled();
    });

    it.each([
        { description: 'Изменённое описание без исправления поставки' },
        { config: { transport: 'stdio' as const, command: 'node' } },
        { dependencies: [{ kind: 'mcp' as const, id: 'ai-plug-other', version: 1, manifest: 'bad' }] },
        { files: [{ path: '../server.js', content: 'export default {}' }] },
    ])('Изменённая недоставляемая карточка всё ещё требует исправления: %j', async changes => {
        const { repository, query } = fixture();
        await expect(repository.update(legacy.id, { ...changes, expectedVersion: 1 }, 'qa@example.test'))
            .rejects.toMatchObject({ status: 400 });
        expect(query.mock.calls.some(([sql]) => /^(INSERT INTO|UPDATE|DELETE FROM) /.test(sql))).toBe(false);
    });

    it.each([
        { config: { transport: 'remote' as const, url: 'https://example.test/mcp' }, files: [] },
        { config: { transport: 'stdio' as const, command: 'node', entrypoint: 'server.mjs' }, files: [{ path: 'server.mjs', content: 'export default {}', size: 17, digest: '' }] },
    ])('Полное исправление старой карточки создаёт доставляемую версию: %j', changes => {
        const { repository } = fixture();
        return expect(repository.update(legacy.id, { ...changes, expectedVersion: 1 }, 'qa@example.test'))
            .resolves.toMatchObject({ id: legacy.id, version: 2, config: changes.config });
    });
});
