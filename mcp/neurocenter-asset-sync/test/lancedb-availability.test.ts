import { describe, expect, it, vi } from 'vitest';
import { contentHash, localRagStatus, tableInfo } from '../src/lib/lancedb.js';

vi.mock('@lancedb/lancedb', () => { throw new Error('Нативная библиотека отсутствует'); });
describe('Отсутствие нативной LanceDB', () => {
    it('Не мешает загрузке остальных функций MCP и сообщает ограничение без падения процесса', async () => {
        expect(contentHash('Инструкция')).toHaveLength(64);
        expect(await localRagStatus()).toMatchObject({ ragSupported: false, ragError: expect.stringContaining('остаётся доступной') });
        await expect(tableInfo('/не-существует')).rejects.toThrow('Нативная LanceDB недоступна');
    });
});
