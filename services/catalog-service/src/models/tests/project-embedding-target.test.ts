import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { ProjectEmbeddingRepository } from '../project-embedding.repository';
import { projectEmbeddingTarget } from '../project-embedding.validation';
import type { IProjectEmbeddingTarget } from '../project-embedding.interfaces';

const SHA = 'a'.repeat(64);
const PROJECT = 'prj-target';
const COMPUTER_TARGET: IProjectEmbeddingTarget = {
    mode: 'computer',
    installation: {
        deviceId: 'device-1',
        assetId: 'asset-1',
        assetKind: 'mcp',
        version: 3,
        expectedManifest: SHA,
    },
};

describe('8.19: projectEmbeddingTarget — валидация персиста «Куда подключить модель»', () => {
    it('null сбрасывает выбор', () => {
        expect(projectEmbeddingTarget(null)).toBeNull();
    });
    it('серверная база знаний без установки', () => {
        expect(projectEmbeddingTarget({ mode: 'server' })).toEqual({ mode: 'server', installation: null });
    });
    it('компьютерная установка проходит с полной стабильной идентичностью', () => {
        expect(projectEmbeddingTarget(COMPUTER_TARGET)).toEqual(COMPUTER_TARGET);
    });
    it('server с установкой отклоняется', () => {
        expect(() => projectEmbeddingTarget({ mode: 'server', installation: COMPUTER_TARGET.installation })).toThrow(
            BadRequestException,
        );
    });
    it.each([
        ['неизвестный mode', { mode: 'local' }],
        ['лишний ключ', { mode: 'server', extra: true }],
        ['computer без установки', { mode: 'computer' }],
        ['установка не объект', { mode: 'computer', installation: 'mcp-1' }],
        [
            'установка без версии',
            { mode: 'computer', installation: { ...COMPUTER_TARGET.installation!, version: null } },
        ],
        [
            'установка с чужим ключом',
            { mode: 'computer', installation: { ...COMPUTER_TARGET.installation!, root: '/tmp' } },
        ],
        [
            'неверный manifest',
            { mode: 'computer', installation: { ...COMPUTER_TARGET.installation!, expectedManifest: 'abc' } },
        ],
        ['пустой deviceId', { mode: 'computer', installation: { ...COMPUTER_TARGET.installation!, deviceId: '' } }],
        [
            'deviceId с пробелом',
            { mode: 'computer', installation: { ...COMPUTER_TARGET.installation!, deviceId: 'device 1' } },
        ],
        ['отрицательная версия', { mode: 'computer', installation: { ...COMPUTER_TARGET.installation!, version: 0 } }],
    ])('отклоняет %s', (_case, value) => {
        expect(() => projectEmbeddingTarget(value)).toThrow(BadRequestException);
    });
});

interface IFakeCalls {
    sql: string;
    args?: unknown[];
}

function fakeTargetPool(row?: { embedding_target?: IProjectEmbeddingTarget | null }): {
    pool: Pool;
    calls: IFakeCalls[];
    authorize: ReturnType<typeof vi.fn>;
} {
    const calls: IFakeCalls[] = [];
    const authorize = vi.fn(async () => undefined);
    const client = {
        query: async (sql: string, args?: unknown[]) => {
            calls.push({ sql, args });
            if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: PROJECT }] };
            if (sql.includes('FROM project_embedding_settings')) return { rows: row ? [row] : [] };
            if (sql.includes('INSERT INTO project_embedding_settings'))
                return {
                    rows: [
                        {
                            project_id: PROJECT,
                            revision: 1,
                            model_id: null,
                            model_pin: null,
                            dimension: null,
                            active_generation: 'initial-x',
                            active_snapshot: null,
                            data_revision: 0,
                            embedding_target: args ? JSON.parse(String(args[1])) : null,
                        },
                    ],
                };
            return { rows: [] };
        },
        release: () => {},
    };
    return { pool: { connect: async () => client } as unknown as Pool, calls, authorize };
}

describe('8.19: ProjectEmbeddingRepository.target — персист в проект', () => {
    it('сохраняет цель одной транзакцией с аудитом и не трогает ревизию', async () => {
        const { pool, calls, authorize } = fakeTargetPool({
            embedding_target: { mode: 'server', installation: null },
        });
        const result = await new ProjectEmbeddingRepository(pool).saveTarget(
            PROJECT,
            COMPUTER_TARGET,
            'actor@example.com',
            authorize,
        );
        expect(result).toEqual(COMPUTER_TARGET);
        expect(authorize).toHaveBeenCalledTimes(1);
        const upsert = calls.find((call) => call.sql.includes('INSERT INTO project_embedding_settings'))!;
        expect(upsert.sql).toContain('ON CONFLICT(project_id) DO UPDATE SET');
        expect(upsert.sql).toContain('embedding_target=EXCLUDED.embedding_target');
        expect(upsert.sql).not.toContain('revision=EXCLUDED');
        expect(JSON.parse(String(upsert.args?.[1]))).toEqual(COMPUTER_TARGET);
        expect(calls.some((call) => call.sql.includes('INSERT INTO security_events'))).toBe(true);
        expect(calls.at(-1)?.sql).toBe('COMMIT');
    });
    it('null записывает сброс выбора', async () => {
        const { pool, calls } = fakeTargetPool({ embedding_target: COMPUTER_TARGET });
        const result = await new ProjectEmbeddingRepository(pool).saveTarget(
            PROJECT,
            null,
            'actor@example.com',
            async () => {},
        );
        expect(result).toBeNull();
        const upsert = calls.find((call) => call.sql.includes('INSERT INTO project_embedding_settings'))!;
        expect(upsert.args?.[1]).toBe('null');
    });
    it('удалённый проект отклоняется с откатом', async () => {
        const calls: IFakeCalls[] = [];
        const client = {
            query: async (sql: string) => {
                calls.push({ sql });
                return { rows: [] };
            },
            release: () => {},
        };
        const repository = new ProjectEmbeddingRepository({ connect: async () => client } as unknown as Pool);
        await expect(
            repository.saveTarget(PROJECT, COMPUTER_TARGET, 'actor@example.com', async () => {}),
        ).rejects.toThrow(NotFoundException);
        expect(calls.at(-1)?.sql).toBe('ROLLBACK');
    });
    it('readTarget возвращает значение и null для проекта без строки', async () => {
        const repository = new ProjectEmbeddingRepository({
            query: async () => ({ rows: [{ embedding_target: COMPUTER_TARGET }] }),
        } as unknown as Pool);
        await expect(repository.readTarget(PROJECT)).resolves.toEqual(COMPUTER_TARGET);
        const empty = new ProjectEmbeddingRepository({ query: async () => ({ rows: [] }) } as unknown as Pool);
        await expect(empty.readTarget(PROJECT)).resolves.toBeNull();
    });
});
