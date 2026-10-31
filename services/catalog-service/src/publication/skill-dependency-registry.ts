import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';

import { normalizeDependencyPins, type IDependencyPin } from '../../../shared/dependency-pins.cjs';
import { securityEvent } from '../access/security-events';
import { assertPublicationDependencies } from './publication-dependencies';

interface ISkillDependencyReservation {
    key: string;
    path: string;
    dependencies: IDependencyPin[];
    purpose?: 'publish' | 'preserve';
}

function reservationEntries(raw: unknown): ISkillDependencyReservation[] {
    const invalid = () =>
        new BadRequestException('Нужны entries: до 200 резервов с SHA-256, путём скилла и точными зависимостями.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'entries')) {
        throw invalid();
    }
    const entries = (raw as Record<string, unknown>).entries;
    if (!Array.isArray(entries) || entries.length > 200) {
        throw invalid();
    }
    return entries.map((entry) => {
        if (
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            Object.keys(entry).some((key) => !['key', 'path', 'dependencies', 'purpose'].includes(key)) ||
            (entry.purpose !== undefined && !['publish', 'preserve'].includes(entry.purpose)) ||
            typeof entry.key !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.key) ||
            typeof entry.path !== 'string' ||
            !entry.path ||
            entry.path.length > 240 ||
            entry.path.split('/').some((part: string) => !/^[a-z0-9][a-z0-9_-]*$/.test(part)) ||
            !Array.isArray(entry.dependencies)
        ) {
            throw invalid();
        }
        try {
            return {
                key: entry.key,
                path: entry.path,
                dependencies: normalizeDependencyPins(entry.dependencies),
                purpose: entry.purpose ?? 'publish',
            };
        } catch {
            throw invalid();
        }
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
            if (entry.purpose === 'publish') {
                await assertPublicationDependencies(client, entry.dependencies);
            }
            const previous = await client.query(
                'SELECT dependencies FROM skill_dependency_reservations WHERE key=$1 AND skill_path=$2',
                [entry.key, entry.path],
            );
            if (previous.rows[0]) {
                if (
                    JSON.stringify(normalizeDependencyPins(previous.rows[0].dependencies)) !==
                    JSON.stringify(entry.dependencies)
                ) {
                    throw new ConflictException('Этот снимок скилла уже зарезервирован с другими зависимостями.');
                }
                continue;
            }
            let unavailable = false;
            if (entry.purpose === 'preserve') {
                try {
                    await assertPublicationDependencies(client, entry.dependencies);
                } catch (error) {
                    if (!(error instanceof ConflictException)) {
                        throw error;
                    }
                    unavailable = true;
                }
            }
            await client.query(
                'INSERT INTO skill_dependency_reservations (key,skill_path,dependencies) VALUES ($1,$2,$3::jsonb)',
                [entry.key, entry.path, JSON.stringify(entry.dependencies)],
            );
            if (unavailable) {
                await securityEvent(client, {
                    actor: 'skills-service',
                    action: 'skill.dependencies.preserve',
                    resourceId: `${entry.path} · ${entry.key}`,
                    before: null,
                    after: {
                        path: entry.path,
                        key: entry.key,
                        dependencies: entry.dependencies,
                        verification: 'unavailable',
                    },
                });
            }
        }
        await client.query('COMMIT');
        return { reserved: entries.length };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
