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
});
