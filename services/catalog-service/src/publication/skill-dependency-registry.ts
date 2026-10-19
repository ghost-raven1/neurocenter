import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { normalizeDependencyPins, type IDependencyPin } from '../../../shared/dependency-pins.cjs';
import { securityEvent } from '../access/security-events';
import { assertPublicationDependencies } from './publication-dependencies';

interface ISkillDependencyReservation {
    key: string;
    path: string;
    dependencies: IDependencyPin[];
    purpose?: 'publish' | 'preserve';
}

/** Резерв хранит только точные pins: содержимое скилла остаётся в файловом сервисе. */
export async function setupSkillDependencyReservations(pool: Pool): Promise<void> {
    await pool.query(`CREATE TABLE IF NOT EXISTS skill_dependency_reservations (
        key TEXT NOT NULL, skill_path TEXT NOT NULL, dependencies JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(key,skill_path)
    )`);
}

function reservationEntries(raw: unknown): ISkillDependencyReservation[] {
    const invalid = () => new BadRequestException('Нужны entries: до 200 резервов с SHA-256, путём скилла и точными зависимостями.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'entries')) { throw invalid(); }
    const entries = (raw as Record<string, unknown>).entries;
    if (!Array.isArray(entries) || entries.length > 200) { throw invalid(); }
    return entries.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || Object.keys(entry).some(key => !['key', 'path', 'dependencies', 'purpose'].includes(key))
            || (entry.purpose !== undefined && !['publish', 'preserve'].includes(entry.purpose))
            || typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key)
            || typeof entry.path !== 'string' || !entry.path || entry.path.length > 240
            || entry.path.split('/').some((part: string) => !/^[a-z0-9][a-z0-9_-]*$/.test(part))
            || !Array.isArray(entry.dependencies)) { throw invalid(); }
        try { return { key: entry.key, path: entry.path, dependencies: normalizeDependencyPins(entry.dependencies), purpose: entry.purpose ?? 'publish' }; }
        catch { throw invalid(); }
    });
}

/** Общая блокировка делает резерв и удаление публикации взаимоисключающими. Резервы не истекают. */
export async function reserveSkillDependencies(pool: Pool, raw: unknown): Promise<{ reserved: number }> {
    const entries = reservationEntries(raw);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:dependency-graph']);
        for (const entry of entries) {
            // Публикация не наследует разрешение от ранее сохранённого повреждённого снимка.
            if (entry.purpose === 'publish') { await assertPublicationDependencies(client, entry.dependencies); }
            const previous = await client.query('SELECT dependencies FROM skill_dependency_reservations WHERE key=$1 AND skill_path=$2', [entry.key, entry.path]);
            if (previous.rows[0]) {
                if (JSON.stringify(normalizeDependencyPins(previous.rows[0].dependencies)) !== JSON.stringify(entry.dependencies)) {
                    throw new ConflictException('Этот снимок скилла уже зарезервирован с другими зависимостями.');
                }
                continue;
            }
            let unavailable = false;
            if (entry.purpose === 'preserve') {
                try { await assertPublicationDependencies(client, entry.dependencies); }
                catch (error) {
                    if (!(error instanceof ConflictException)) { throw error; }
                    unavailable = true;
                }
            }
            await client.query('INSERT INTO skill_dependency_reservations (key,skill_path,dependencies) VALUES ($1,$2,$3::jsonb)',
                [entry.key, entry.path, JSON.stringify(entry.dependencies)]);
            if (unavailable) {
                await securityEvent(client, { actor: 'skills-service', action: 'skill.dependencies.preserve',
                    resourceId: `${entry.path} · ${entry.key}`, before: null,
                    after: { path: entry.path, key: entry.key, dependencies: entry.dependencies, verification: 'unavailable' } });
            }
        }
        await client.query('COMMIT');
        return { reserved: entries.length };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}

/** Сохранённый резерв защищает текущие, исторические и ещё не записанные файловые снимки. */
export async function assertSkillReservationsUnreferenced(client: PoolClient, id: string): Promise<void> {
    const used = await client.query('SELECT 1 FROM skill_dependency_reservations WHERE dependencies @> $1::jsonb LIMIT 1', [JSON.stringify([{ id }])]);
    if (used.rows.length) {
        throw new ConflictException('Инструмент закреплён в текущей или исторической версии скилла либо зарезервирован для её записи. Удаление нарушит восстановление.');
    }
}

/** Старые файловые снимки проверяются при каждом удалении; отказ сервиса запрещает удаление. */
export async function assertRemoteSkillUnreferenced(id: string): Promise<void> {
    try {
        const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
        const base = new URL(process.env.SKILLS_SERVICE_URL || 'http://localhost:4200');
        if (!token || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) { throw new Error('Недоступна служебная конфигурация'); }
        const url = new URL('/internal/skill-dependencies/usage', base);
        url.searchParams.set('assetId', id);
        const response = await fetch(url, { headers: { 'x-neurocenter-internal': token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (response.status !== 200) { throw new Error('Сервис скиллов недоступен'); }
        const usage: unknown = await response.json();
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)
            || Object.keys(usage).some(key => key !== 'inUse') || typeof (usage as { inUse?: unknown }).inUse !== 'boolean') {
            throw new Error('Некорректный ответ сервиса скиллов');
        }
        if ((usage as { inUse: boolean }).inUse) {
            throw new ConflictException('Удаление остановлено: инструмент нужен сохранённым версиям скиллов. Удаление текущего файла не очищает историю.');
        }
    } catch (error) {
        if (error instanceof ConflictException) { throw error; }
        throw new ServiceUnavailableException('Не удалось проверить зависимости скиллов. Удаление остановлено; повторите после восстановления сервиса.');
    }
}
