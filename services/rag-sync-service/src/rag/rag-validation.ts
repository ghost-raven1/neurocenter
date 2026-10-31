import { BadRequestException } from '@nestjs/common';
import type { ISyncChunk } from './dto';

/** Проверяет весь пакет до SQL-транзакции, включая размерность и конфликтующие идентификаторы. */
export function validateDelta(
    chunks: unknown,
    deletes: unknown,
    dimension: number,
): { chunks: ISyncChunk[]; deletes: string[] } {
    const invalid = (message: string): never => {
        throw new BadRequestException(message);
    };
    const id = (value: unknown): value is string =>
        typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 512 && !value.includes('\0');
    if (!Array.isArray(chunks) || !Array.isArray(deletes)) {
        return invalid('chunks и deletes должны быть массивами.');
    }
    if (chunks.length > 1000 || deletes.length > 10000) {
        return invalid('Разбейте синхронизацию на пакеты до 1000 фрагментов и 10000 удалений.');
    }
    if (deletes.some((value) => !id(value))) {
        return invalid('Удаляемый фрагмент должен иметь непустой строковый ID.');
    }
    const deleted = new Set(deletes as string[]);
    const seen = new Set<string>();
    for (const value of chunks) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return invalid('Фрагмент должен быть объектом.');
        }
        const row = value as Record<string, unknown>;
        if (!id(row.id) || typeof row.filePath !== 'string' || typeof row.content !== 'string') {
            return invalid('Фрагменту нужны строковые id, filePath и content.');
        }
        if (Buffer.byteLength(row.filePath) > 4096) {
            return invalid('Путь фрагмента превышает 4096 байт.');
        }
        if (seen.has(row.id) || deleted.has(row.id)) {
            return invalid('ID фрагментов повторяются или одновременно указаны для записи и удаления.');
        }
        seen.add(row.id);
        for (const field of ['description', 'language', 'kind', 'role', 'quirkType', 'tags']) {
            if (row[field] !== undefined && row[field] !== null && typeof row[field] !== 'string') {
                return invalid(`Поле ${field} должно быть строкой.`);
            }
        }
        for (const field of ['startLine', 'endLine']) {
            const number = row[field];
            if (
                number !== undefined &&
                number !== null &&
                (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > 2147483647)
            ) {
                return invalid(`Поле ${field} должно быть неотрицательным целым числом.`);
            }
        }
        if (typeof row.startLine === 'number' && typeof row.endLine === 'number' && row.endLine < row.startLine) {
            return invalid('Конец фрагмента не может находиться раньше начала.');
        }
        const embedding = row.embedding;
        if (
            embedding !== undefined &&
            embedding !== null &&
            (!Array.isArray(embedding) ||
                embedding.length !== dimension ||
                embedding.some((number) => typeof number !== 'number' || !Number.isFinite(Math.fround(number))))
        ) {
            return invalid(`Вектор должен содержать ${dimension} конечных чисел в диапазоне float32.`);
        }
    }
    return { chunks: chunks as ISyncChunk[], deletes: [...deleted] };
}

/** Ограничивает пагинацию до обращения к PostgreSQL, не округляя ошибочные дробные значения. */
export function ragPagination(limit: unknown, offset: unknown): { limit: number; offset: number } {
    const integer = (value: unknown, fallback: number, min: number): number => {
        if (value === undefined) {
            return fallback;
        }
        const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
        if (!Number.isSafeInteger(number) || number < min) {
            throw new BadRequestException('limit и offset должны быть целыми числами в допустимом диапазоне.');
        }
        return number;
    };
    return { limit: Math.min(2000, integer(limit, 1000, 1)), offset: integer(offset, 0, 0) };
}
