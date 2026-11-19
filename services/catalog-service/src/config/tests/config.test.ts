import { describe, expect, it } from 'vitest';
import { loadCatalogConfig } from '../index';

/** AD-9: config-модуль catalog-service — владелец валидации числовых env; fail-fast + маскировка. */
describe('Конфигурация catalog-service (AD-9)', () => {
    it('default: PORT=4100, backup 64G/16G/1G, контекст null', () => {
        const { values } = loadCatalogConfig({});
        expect(values.port).toBe(4100);
        expect(values.backupMaxTotalBytes).toBe(64 * 1024 ** 3);
        expect(values.backupMaxFileBytes).toBe(16 * 1024 ** 3);
        expect(values.backupMinFreeBytes).toBe(1024 ** 3);
        expect(values.contextWindowTokens).toBeNull();
    });

    it.each(['abc', '0', '-1', '1.5', '1e999', 'NaN', 'Infinity'])(
        'BACKUP_MAX_TOTAL_BYTES=%s — fail-fast (NaN/overflow/≤0)',
        (raw) => {
            expect(() => loadCatalogConfig({ BACKUP_MAX_TOTAL_BYTES: raw })).toThrow(/BACKUP_MAX_TOTAL_BYTES/);
        },
    );

    it('BACKUP_MAX_FILE_BYTES не-число — fail-fast', () => {
        expect(() => loadCatalogConfig({ BACKUP_MAX_FILE_BYTES: 'abc' })).toThrow(/BACKUP_MAX_FILE_BYTES/);
    });

    it('BACKUP_MIN_FREE_BYTES=0 — fail-fast (positive)', () => {
        expect(() => loadCatalogConfig({ BACKUP_MIN_FREE_BYTES: '0' })).toThrow(/BACKUP_MIN_FREE_BYTES/);
    });

    it('BACKUP_MAX_FILE_BYTES > BACKUP_MAX_TOTAL_BYTES — fail-fast (перекрёстная проверка)', () => {
        expect(() =>
            loadCatalogConfig({ BACKUP_MAX_FILE_BYTES: '20000000000', BACKUP_MAX_TOTAL_BYTES: '10000000000' }),
        ).toThrow(/BACKUP_MAX_FILE_BYTES/);
    });

    it.each(['127', '2097153', '-1', '0'])('MODEL_CHAT_CONTEXT_WINDOW_TOKENS=%s — fail-fast (вне 128..2097152)', (raw) => {
        expect(() => loadCatalogConfig({ MODEL_CHAT_CONTEXT_WINDOW_TOKENS: raw })).toThrow(
            /MODEL_CHAT_CONTEXT_WINDOW_TOKENS/,
        );
    });

    it('MODEL_CHAT_CONTEXT_WINDOW_TOKENS валидное значение принимается', () => {
        expect(loadCatalogConfig({ MODEL_CHAT_CONTEXT_WINDOW_TOKENS: '8192' }).values.contextWindowTokens).toBe(8192);
    });

    it('PORT=abc — fail-fast с именем переменной (dev-режим)', () => {
        expect(() => loadCatalogConfig({ PORT: 'abc' })).toThrow(/PORT/);
    });

    it('агрегированный отчёт: несколько ошибок сразу', () => {
        try {
            loadCatalogConfig({ PORT: 'abc', BACKUP_MAX_TOTAL_BYTES: '1e999' });
            throw new Error('Должен был бросить');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toMatch(/PORT/);
            expect(message).toMatch(/BACKUP_MAX_TOTAL_BYTES/);
            expect((error as { issues?: string[] }).issues).toHaveLength(2);
        }
    });

    it('секреты в отчёте: значения маскированы', () => {
        const { report } = loadCatalogConfig({ CATALOG_PG_URL: 'postgresql://u:p@h:5432/db' });
        const url = report.find((entry) => entry.name === 'CATALOG_PG_URL');
        expect(url?.value).toBe('***');
        expect(JSON.stringify(report)).not.toContain('postgresql://u:p@h:5432/db');
    });
});
