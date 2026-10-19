import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { buildPackage } from '../src/catalog/bundle-package';
import { reserveSkillDependencies } from '../src/publication/skill-dependency-registry';

const config = { transport: 'remote' as const, url: 'https://example.test/mcp' };
const dependency = { id: 'ai-plug-legacy', name: 'Исторический MCP', kind: 'mcp', files: [], config, metadata: { kind: 'mcp' } };
const pin = { kind: 'mcp', id: dependency.id, version: 1,
    manifest: buildPackage({ id: dependency.id, name: dependency.name, kind: 'mcp', version: 1 }, [], '', config).manifest.sha256 };
const entry = { key: 'a'.repeat(64), path: 'shared/legacy-search', dependencies: [pin] };
const preserve = { ...entry, purpose: 'preserve' };

describe('Сохранение ссылок повреждённого файлового снимка', () => {
    let pool: Pool;
    let query: ReturnType<typeof vi.fn>;
    let release: ReturnType<typeof vi.fn>;
    let stored: unknown[] | undefined;
    let target: typeof dependency | undefined;

    beforeEach(() => {
        stored = undefined;
        target = dependency;
        query = vi.fn(async (sql: string) => {
            if (sql.includes('JOIN ai_plugin_versions')) { return { rows: target ? [target] : [] }; }
            if (sql.startsWith('SELECT dependencies FROM skill_dependency_reservations')) { return { rows: stored ? [{ dependencies: stored }] : [] }; }
            return { rows: [] };
        });
        release = vi.fn();
        pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
    });

    const events = (query: ReturnType<typeof vi.fn>) => query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO security_events'));

    it.each(['missing', 'version', 'kind', 'sha'])('Оставляет защитную ссылку и квитанцию при нарушении %s', async failure => {
        if (failure === 'missing' || failure === 'version') { target = undefined; }
        const dependencies = [{ ...pin, ...(failure === 'version' ? { version: 2 } : {}),
            ...(failure === 'kind' ? { kind: 'plugin' } : {}), ...(failure === 'sha' ? { manifest: 'b'.repeat(64) } : {}) }];
        expect(await reserveSkillDependencies(pool, { entries: [{ ...preserve, dependencies }] })).toEqual({ reserved: 1 });
        expect(query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO skill_dependency_reservations'))?.[1])
            .toEqual([entry.key, entry.path, JSON.stringify(dependencies)]);
        expect(events(query)).toHaveLength(1);
        const event = events(query)[0][1] as unknown[];
        expect(event.slice(1, 4)).toEqual(['skills-service', 'skill.dependencies.preserve', `${entry.path} · ${entry.key}`]);
        expect(JSON.parse(String(event[4]))).toBeNull();
        expect(JSON.parse(String(event[5]))).toEqual({ path: entry.path, key: entry.key, dependencies, verification: 'unavailable' });
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(query.mock.calls.some(([sql]) => /^(DELETE|UPDATE) /.test(sql))).toBe(false);
    });

    it('Исправный старый снимок резервируется без события о недоступной зависимости', async () => {
        expect(await reserveSkillDependencies(pool, { entries: [preserve] })).toEqual({ reserved: 1 });
        expect(events(query)).toHaveLength(0);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO skill_dependency_reservations'))).toBe(true);
    });

    it('Повтор сохранённого снимка не проверяет утраченную цель и не дублирует квитанцию', async () => {
        stored = [pin];
        target = undefined;
        expect(await reserveSkillDependencies(pool, { entries: [preserve] })).toEqual({ reserved: 1 });
        expect(query.mock.calls.some(([sql]) => sql.includes('JOIN ai_plugin_versions'))).toBe(false);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT '))).toBe(false);
    });

    it('Старый ключ нельзя сохранить с изменёнными зависимостями', async () => {
        stored = [];
        await expect(reserveSkillDependencies(pool, { entries: [preserve] })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.includes('JOIN ai_plugin_versions'))).toBe(false);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT '))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it.each([undefined, 'publish'])('Новая публикация с режимом %s не использует сохранённый повреждённый ключ', async purpose => {
        stored = [pin];
        target = undefined;
        await expect(reserveSkillDependencies(pool, { entries: [{ ...entry, purpose }] })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.includes('JOIN ai_plugin_versions'))).toBe(true);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('SELECT dependencies FROM skill_dependency_reservations'))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Публикация проверяет зависимости, даже если пакет уже содержит preserve того же ключа', async () => {
        stored = [pin];
        target = undefined;
        await expect(reserveSkillDependencies(pool, { entries: [preserve, entry] })).rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.filter(([sql]) => sql.includes('JOIN ai_plugin_versions'))).toHaveLength(1);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Исправная новая публикация допускает прежний защитный резерв', async () => {
        stored = [pin];
        expect(await reserveSkillDependencies(pool, { entries: [{ ...entry, purpose: 'publish' }] })).toEqual({ reserved: 1 });
        const verification = query.mock.calls.findIndex(([sql]) => sql.includes('JOIN ai_plugin_versions'));
        const previous = query.mock.calls.findIndex(([sql]) => sql.startsWith('SELECT dependencies FROM skill_dependency_reservations'));
        expect(verification).toBeGreaterThan(-1);
        expect(verification).toBeLessThan(previous);
        expect(events(query)).toHaveLength(0);
    });

    it('Отказ аудита откатывает новый защитный резерв', async () => {
        target = undefined;
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Аудит недоступен'); }
            return original(sql);
        });
        await expect(reserveSkillDependencies(pool, { entries: [preserve] })).rejects.toThrow('Аудит недоступен');
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO skill_dependency_reservations'))).toBe(true);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Неизвестный отказ БД запрещает сохранение и не превращается в квитанцию', async () => {
        const failure = new Error('Соединение потеряно');
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string) => {
            if (sql.includes('JOIN ai_plugin_versions')) { throw failure; }
            return original(sql);
        });
        await expect(reserveSkillDependencies(pool, { entries: [preserve] })).rejects.toBe(failure);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT '))).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Невалидная публикация откатывает предшествующий защитный резерв и его аудит', async () => {
        target = undefined;
        await expect(reserveSkillDependencies(pool, { entries: [preserve, { ...entry, key: 'c'.repeat(64) }] }))
            .rejects.toMatchObject({ status: 409 });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO skill_dependency_reservations'))).toBe(true);
        expect(events(query)).toHaveLength(1);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it.each([
        { ...preserve, purpose: 'other' }, { ...preserve, purpose: null }, { ...preserve, purpose: true },
        { ...preserve, dependencies: [{ ...pin, version: 0 }] },
        { ...preserve, dependencies: [{ ...pin, manifest: 'not-a-sha' }] },
        { ...preserve, dependencies: [{ ...pin, body: 'private-source' }] },
        { ...preserve, actor: 'administrator' },
    ])('Режим сохранения не ослабляет проверку метаданных: %j', async invalid => {
        await expect(reserveSkillDependencies(pool, { entries: [invalid] })).rejects.toMatchObject({ status: 400 });
        expect(pool.connect).not.toHaveBeenCalled();
    });
});
