import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeJournal, parseJournal, type Journal } from '../src/bridge/installation-journal.js';
import { JOURNAL_BYTES_LIMIT } from '../src/bridge/installation-limits.js';

describe('Лимиты закодированного журнала восстановления', () => {
    const journal = (count: number): Journal => ({
        version: 1, root: '/изолированный-проект', id: randomUUID(), state: 'prepared', action: 'install',
        assetKey: 'a'.repeat(24), manifest: 'b'.repeat(64),
        changes: Array.from({ length: count }, (_, index) => ({ relative: `file-${index}`, before: null, after: '\0'.repeat(1048576) })),
    });
    it('Принимает JSON больше 32 МиБ при допустимом объёме исходных файлов', () => {
        const source = journal(10); const text = encodeJournal(source);
        expect(Buffer.byteLength(text)).toBeGreaterThan(32 * 1048576); expect(Buffer.byteLength(text)).toBeLessThan(JOURNAL_BYTES_LIMIT);
        expect(parseJournal(text, source.root).changes).toHaveLength(10);
    });
    it('Отвергает закодированный JSON больше 64 МиБ при допустимом decoded объёме', () => {
        expect(() => encodeJournal(journal(11))).toThrow('64 МиБ');
    });
    it.each([0, 0o751, 0o777])('Сохраняет известный исходный режим %i после чтения журнала', beforeMode => {
        const source = journal(0); source.changes = [{ relative: 'old.sh', before: 'до', after: null, beforeMode }];
        expect(parseJournal(encodeJournal(source), source.root).changes[0]!.beforeMode).toBe(beforeMode);
    });
    it('Читает старый журнал без выдуманного исходного режима', () => {
        const source = journal(0); source.changes = [{ relative: 'old.sh', before: 'до', after: null }];
        expect(parseJournal(encodeJournal(source), source.root).changes[0]).not.toHaveProperty('beforeMode');
    });
    it.each([null, -1, 0o1000, 1.5, '0751', true])('Отклоняет некорректный исходный режим %j в сохранённом журнале', beforeMode => {
        const source = journal(0); const text = JSON.stringify({ ...source, changes: [{ relative: 'old.sh', before: 'до', after: null, beforeMode }] });
        expect(() => parseJournal(text, source.root)).toThrow('Повреждён локальный журнал');
    });
    it('Отклоняет режим файла, отсутствовавшего до операции', () => {
        const source = journal(0); source.changes = [{ relative: 'new.sh', before: null, after: 'новый', beforeMode: 0o751 }];
        expect(() => parseJournal(JSON.stringify(source), source.root)).toThrow('Повреждён локальный журнал');
    });
});
