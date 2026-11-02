import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { assertBuildCreateName } from '../publication-target';

const card = { id: '12345678-1234-4234-8234-123456789012', kind: 'mcp', name: 'Example', archived_at: null };
const makePool = (rows: Record<string, unknown>[]) => {
    const query = vi.fn().mockResolvedValue({ rows });
    return { pool: { query } as never, query };
};

describe('assertBuildCreateName name conflict', () => {
    it('carries the structured name-conflict payload with the existing card details', async () => {
        const error = (await assertBuildCreateName(makePool([card]).pool, {
            kind: 'mcp',
            name: 'example',
        }).catch((error): unknown => error)) as ConflictException;
        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getResponse()).toEqual({
            code: 'name-conflict',
            catalogId: card.id,
            kind: 'mcp',
            archived: false,
            message:
                'Инструмент с таким названием уже существует. Откройте «Новая версия» в его карточке или выберите другое имя; исходники сохранены.',
        });
    });
    it('marks the archived flag when the conflicting card is archived', async () => {
        const error = (await assertBuildCreateName(
            makePool([{ ...card, archived_at: new Date() }]).pool,
            { kind: 'plugin', name: 'example' },
        ).catch((error): unknown => error)) as ConflictException;
        expect(error.getResponse()).toMatchObject({ code: 'name-conflict', archived: true });
    });
    it('stays silent for the update path and skills without touching the database', async () => {
        const { pool: quiet, query } = makePool([]);
        await assertBuildCreateName(quiet, {
            kind: 'mcp',
            name: 'example',
            publication: { catalogId: card.id, expectedVersion: 1, expectedSourceHash: 'a'.repeat(64) },
        });
        await assertBuildCreateName(quiet, { kind: 'skill', name: 'example' });
        expect(query).not.toHaveBeenCalled();
    });
});
