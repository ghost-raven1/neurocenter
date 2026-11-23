import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AD-D4 инвариант: каждое quota-поле в API/DB обязано иметь enforcement-точку
 * (файл) и тест; поле без точки и без allowlist-причины — дефект (поле удаляется
 * из API). Таблица ниже — единственная декларация покрытия: поле → точки + тесты.
 *
 * used-поля (epic-data entry 1) обеспечены единственной точкой записи accounting:
 * recordProjectQuotaUsage — любой дрейф used невозможен без изменения этой точки,
 * её поведение зафиксировано quota-usage.test.ts.
 */

// Корень репозитория: services/catalog-service/src/project-quota-usage/tests/ → 5 уровней вверх.
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');
const exists = (relative: string): boolean => existsSync(path.join(repoRoot, relative));

const QUOTA_FIELDS = [
    'currentBytesLimit',
    'retentionBytesLimit',
    'stagingBytesLimit',
    'currentBytesUsed',
    'retentionBytesUsed',
    'stagingBytesUsed',
] as const;
type TQuotaField = (typeof QUOTA_FIELDS)[number];

interface ICoverage {
    /** Enforcement-точки: файлы, сравнивающие/обеспечивающие поле (маркер — ссылка на quota-механику). */
    points: string[];
    /** Тесты, фиксирующие поведение точки. */
    tests: string[];
}

const ACCOUNTING_POINT = 'services/catalog-service/src/project-quota-usage/quota-usage-core.ts';
const ACCOUNTING_TEST = 'services/catalog-service/src/project-quota-usage/tests/quota-usage.test.ts';

const COVERAGE: Record<TQuotaField, ICoverage> = {
    // Лимит файлов проекта: pre-write проверка в skills-service (current) + boundary
    // LRU-эвикции кэша артефактов MCP (эвикция уважает per-project лимит).
    currentBytesLimit: {
        points: [
            'services/skills-service/src/storage/fs-skills-storage.ts',
            'services/api-gateway/src/features/mcp-host/artifact-cache.ts',
        ],
        tests: [
            'services/skills-service/integration/test/quota-enforcement.test.ts',
            'services/api-gateway/src/features/mcp-host/tests/artifact-cache.test.ts',
        ],
    },
    // Лимит базы знаний: pre-write проверка RAG-пакетной записи и копирования поколения.
    retentionBytesLimit: {
        points: [
            'services/rag-sync-service/src/rag/rag-db.ts',
            'services/rag-sync-service/src/rag/rag-generations.ts',
        ],
        tests: ['services/rag-sync-service/src/rag/tests/quota-enforcement.test.ts'],
    },
    // Лимит in-flight-объёма (OQ-1): публикация проектного снимка — единственная
    // project-scoped in-flight операция main; проверка в beginManifest + кредит/дебит.
    stagingBytesLimit: {
        points: ['services/catalog-service/src/snapshots/snapshot-repository.ts'],
        tests: ['services/catalog-service/src/snapshots/tests/quota-enforcement.test.ts'],
    },
    // used-поля обеспечены единственной точкой записи accounting (recordProjectQuotaUsage).
    currentBytesUsed: { points: [ACCOUNTING_POINT], tests: [ACCOUNTING_TEST] },
    retentionBytesUsed: { points: [ACCOUNTING_POINT], tests: [ACCOUNTING_TEST] },
    stagingBytesUsed: { points: [ACCOUNTING_POINT], tests: [ACCOUNTING_TEST] },
};

const fields: TQuotaField[] = [...QUOTA_FIELDS];

describe('AD-D4 инвариант: quota-поля → enforcement-точка + тест', () => {
    it('таблица покрывает ровно 6 полей IQuota (dto.ts)', () => {
        expect([...Object.keys(COVERAGE)].sort()).toEqual([...QUOTA_FIELDS].sort());
        // IQuota в dto.ts сохраняет все шесть полей — иначе инвариант устарел.
        const dto = read('services/catalog-service/src/catalog/dto.ts');
        for (const field of QUOTA_FIELDS) {
            expect(dto, `IQuota потерял поле ${field}: инвариант и API разошлись`).toContain(field + ':');
        }
    });

    it.each(fields)('поле %s имеет enforcement-точку и тест (иначе — дефект: удалить поле из API)', (field) => {
            const coverage = COVERAGE[field];
            for (const point of coverage.points) {
                expect(exists(point), `У поля ${field} нет enforcement-точки: ${point}`).toBe(true);
                // Точка связана с quota-механикой (guard/accounting/quota-модуль).
                expect(read(point).toLowerCase(), `Файл точки ${point} не содержит quota-ссылки`).toContain('quota');
            }
            for (const test of coverage.tests) {
                expect(exists(test), `У поля ${field} нет теста: ${test}`).toBe(true);
            }
        });

    it('allowlist не существует: каждый limit-полю нужны pre-write точки', () => {
        for (const field of ['currentBytesLimit', 'retentionBytesLimit', 'stagingBytesLimit'] as const) {
            expect(COVERAGE[field].points.length, `Лимит ${field} должен иметь pre-write точку`).toBeGreaterThan(0);
        }
    });
});
