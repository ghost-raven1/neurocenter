import { describe, expect, it } from 'vitest';
import { loadRagSyncConfig } from '../index';

/** AD-9: config-модуль rag-sync-service — владелец валидации числовых env; fail-fast + маскировка. */
describe('Конфигурация rag-sync-service (AD-9)', () => {
    it('default: PORT=4300, RAG квота 1G/16G', () => {
        const { values } = loadRagSyncConfig({});
        expect(values.port).toBe(4300);
        expect(values.ragDefaultQuotaBytes).toBe(1024 ** 3);
        expect(values.ragMaxQuotaBytes).toBe(16 * 1024 ** 3);
    });

    it.each(['abc', '0', '-5', '1e999', 'NaN'])('RAG_DEFAULT_QUOTA_BYTES=%s — fail-fast', (raw) => {
        expect(() => loadRagSyncConfig({ RAG_DEFAULT_QUOTA_BYTES: raw })).toThrow(/RAG_DEFAULT_QUOTA_BYTES/);
    });

    it('RAG_MAX_QUOTA_BYTES не-число — fail-fast', () => {
        expect(() => loadRagSyncConfig({ RAG_MAX_QUOTA_BYTES: 'abc' })).toThrow(/RAG_MAX_QUOTA_BYTES/);
    });

    it('RAG_DEFAULT_QUOTA_BYTES > RAG_MAX_QUOTA_BYTES — fail-fast (перекрёстная проверка)', () => {
        expect(() =>
            loadRagSyncConfig({ RAG_DEFAULT_QUOTA_BYTES: '20000000000', RAG_MAX_QUOTA_BYTES: '10000000000' }),
        ).toThrow(/RAG_DEFAULT_QUOTA_BYTES/);
    });

    it('PORT=abc — fail-fast (dev-режим)', () => {
        expect(() => loadRagSyncConfig({ PORT: 'abc' })).toThrow(/PORT/);
    });

    it('агрегированный отчёт: несколько ошибок сразу', () => {
        try {
            loadRagSyncConfig({ PORT: 'xyz', RAG_DEFAULT_QUOTA_BYTES: '-1' });
            throw new Error('Должен был бросить');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toMatch(/PORT/);
            expect(message).toMatch(/RAG_DEFAULT_QUOTA_BYTES/);
            expect((error as { issues?: string[] }).issues).toHaveLength(2);
        }
    });

    it('секреты в отчёте: значения маскированы', () => {
        const { report } = loadRagSyncConfig({ RAG_PG_URL: 'postgresql://u:p@h:5432/rag' });
        const url = report.find((entry) => entry.name === 'RAG_PG_URL');
        expect(url?.value).toBe('***');
        expect(JSON.stringify(report)).not.toContain('postgresql://u:p@h:5432/rag');
    });
});
