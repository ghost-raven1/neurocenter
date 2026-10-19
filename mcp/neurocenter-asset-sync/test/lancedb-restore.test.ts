import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeRows, readRowsByIds, tableInfo } from '../src/lib/lancedb.js';

describe('Первое скачивание LanceDB с пустыми полями', () => {
    let root: string;
    const row = {
        id: 'a',
        content: 'знания',
        description: null,
        filePath: 'README.md',
        startLine: null,
        endLine: null,
        language: null,
        kind: null,
        role: null,
        quirkType: null,
        tags: null,
        embedding: [0.1, 0.2, 0.3],
    };
    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-lance-'));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });
    it('Создаёт типизированные nullable-колонки и вектор нужной размерности', async () => {
        const result = await writeRows(root, [row], false, 3);
        expect(result.created).toBe(true);
        const info = await tableInfo(root);
        expect(info.rowCount).toBe(1);
        expect(info.dimension).toBe(3);
        const read = [];
        for await (const entry of readRowsByIds(root, ['a'])) {
            read.push(entry);
        }
        expect(read[0]?.description).toBeNull();
        expect(read[0]?.content).toBe('знания');
    });
    it('Следующая порция обновляет nullable-поля без изменения схемы', async () => {
        await writeRows(root, [row], false, 3);
        await writeRows(
            root,
            [{ ...row, description: 'теперь заполнено', startLine: 7 }],
            false,
            3,
        );
        const read = [];
        for await (const entry of readRowsByIds(root, ['a'])) {
            read.push(entry);
        }
        expect(read[0]?.description).toBe('теперь заполнено');
        expect(read[0]?.startLine).toBe(7);
        expect((await tableInfo(root)).rowCount).toBe(1);
    });
    it('Создаёт nullable-вектор по серверной размерности даже без эмбеддинга в первой строке', async () => {
        await writeRows(root, [{ ...row, embedding: null }], false, 3);
        expect((await tableInfo(root)).dimension).toBe(3);
    });
});
