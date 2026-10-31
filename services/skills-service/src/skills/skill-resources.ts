import { BadRequestException } from '@nestjs/common';

import type { ISkillResource } from './skills.model';

/**
 * Ограничения на ресурсы одного скилла.
 */
const MAX_RESOURCE_COUNT = 99;

const MAX_PATH_LENGTH = 200;
const MAX_PATH_PART_LENGTH = 240;

const MAX_SINGLE_RESOURCE_SIZE = 1024 * 1024; // 1 МиБ
const MAX_TOTAL_RESOURCES_SIZE = 4 * 1024 * 1024; // 4 МиБ

/**
 * Разрешённые корневые директории ресурсов.
 */
const ALLOWED_RESOURCE_DIRECTORIES = ['scripts', 'references', 'assets'];

/**
 * Проверяет имя отдельного компонента пути.
 *
 * Запрещает:
 * - пустые компоненты;
 * - "." и "..";
 * - слишком длинные имена;
 * - недопустимые символы;
 * - имена, заканчивающиеся точкой или пробелом;
 * - зарезервированные имена Windows.
 */
function isValidPathPart(part: string): boolean {
    if (!part || part === '.' || part === '..') {
        return false;
    }

    if (Buffer.byteLength(part, 'utf8') > MAX_PATH_PART_LENGTH) {
        return false;
    }

    // Запрещённые символы файловых систем Windows.
    if (/[<>:"|?*\x00-\x1f\x7f]/.test(part)) {
        return false;
    }

    // Windows не допускает точку и пробел в конце имени.
    if (/[. ]$/.test(part)) {
        return false;
    }

    // Зарезервированные имена Windows:
    // CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9.
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)) {
        return false;
    }

    return true;
}

/**
 * Проверяет относительный путь ресурса.
 *
 * Разрешены только пути внутри:
 * scripts/
 * references/
 * assets/
 *
 * Абсолютные пути и обратные слеши запрещены.
 */
function isValidResourcePath(path: string): boolean {
    // Ограничиваем общую длину пути.
    if (path.length > MAX_PATH_LENGTH) {
        return false;
    }

    // Проверяем принадлежность к разрешённой директории.
    const hasAllowedRoot = ALLOWED_RESOURCE_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`));

    if (!hasAllowedRoot) {
        return false;
    }

    // Запрещаем Windows-разделитель путей.
    if (path.includes('\\')) {
        return false;
    }

    // Проверяем каждый компонент пути отдельно.
    const parts = path.split('/');

    return parts.every(isValidPathPart);
}

/**
 * Проверяет конфликт путей.
 *
 * Конфликтом считается:
 * - полное совпадение путей;
 * - совпадение без учёта регистра;
 * - совпадение после Unicode-нормализации NFC;
 * - вложенность одного ресурса в другой.
 *
 * Например:
 * scripts/config.json
 * scripts/config.json/child.txt
 *
 * Такие пути не должны сосуществовать.
 */
function hasPathConflict(path: string, existingPaths: Set<string>): boolean {
    const normalizedPath = path.normalize('NFC').toLowerCase();

    for (const existingPath of existingPaths) {
        if (
            existingPath === normalizedPath ||
            existingPath.startsWith(`${normalizedPath}/`) ||
            normalizedPath.startsWith(`${existingPath}/`)
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Проверяет содержимое ресурса и его кодирование.
 *
 * Поддерживаются:
 * - UTF-8 (кодирование по умолчанию);
 * - base64.
 *
 * Для base64 дополнительно проверяется каноничность кодирования.
 */
function decodeResourceContent(resource: ISkillResource): Buffer {
    if (typeof resource.content !== 'string' || ![undefined, 'utf8', 'base64'].includes(resource.encoding)) {
        throw new BadRequestException('Ресурс должен содержать строку UTF-8 или base64.');
    }

    const isBase64 = resource.encoding === 'base64';

    const bytes = Buffer.from(resource.content, isBase64 ? 'base64' : 'utf8');

    // Buffer.from() может принимать некорректный base64.
    // Поэтому проверяем обратное преобразование.
    if (isBase64 && bytes.toString('base64') !== resource.content) {
        throw new BadRequestException('Некорректное base64-кодирование ресурса.');
    }

    return bytes;
}

/**
 * Проверяет весь набор ресурсов до записи в хранилище.
 *
 * Гарантии:
 * 1. Не более 99 ресурсов.
 * 2. Пути относительные и переносимые.
 * 3. Разрешены только scripts/, references/ и assets/.
 * 4. Нет дублирующихся и конфликтующих путей.
 * 5. Поддерживается UTF-8 и base64.
 * 6. Размер одного ресурса не превышает 1 МиБ.
 * 7. Общий размер не превышает 4 МиБ.
 *
 * Возвращает ресурсы с нормализованными путями,
 * отсортированные по имени пути.
 */
export function validateResources(value: unknown): ISkillResource[] {
    // Отсутствие ресурсов считается пустым массивом.
    if (value === undefined) {
        return [];
    }

    // Проверяем тип и количество ресурсов.
    if (!Array.isArray(value) || value.length > MAX_RESOURCE_COUNT) {
        throw new BadRequestException('Допускается до 99 ресурсов скилла.');
    }

    const existingPaths = new Set<string>();

    let totalBytes = 0;

    // Проверяем каждый ресурс.
    const resources = value.map((item: ISkillResource) => {
        // ----------------------------------------------
        // 1. Проверка структуры и пути
        // ----------------------------------------------

        if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !isValidResourcePath(item.path)) {
            throw new BadRequestException(
                'Ресурс должен находиться в scripts/, references/ или assets/ и иметь переносимый относительный путь.',
            );
        }

        // ----------------------------------------------
        // 2. Проверка конфликтов путей
        // ----------------------------------------------

        const normalizedPath = item.path.normalize('NFC');

        if (hasPathConflict(normalizedPath, existingPaths)) {
            throw new BadRequestException('Пути ресурсов конфликтуют между собой.');
        }

        // Запоминаем путь в нормализованном виде
        // и без учёта регистра.
        existingPaths.add(normalizedPath.toLowerCase());

        // ----------------------------------------------
        // 3. Проверка содержимого и кодирования
        // ----------------------------------------------

        const bytes = decodeResourceContent(item);

        // ----------------------------------------------
        // 4. Проверка размера
        // ----------------------------------------------

        if (bytes.length > MAX_SINGLE_RESOURCE_SIZE) {
            throw new BadRequestException('Ресурс превышает 1 МиБ или общий объём ресурсов больше 4 МиБ.');
        }

        totalBytes += bytes.length;

        if (totalBytes > MAX_TOTAL_RESOURCES_SIZE) {
            throw new BadRequestException('Ресурс превышает 1 МиБ или общий объём ресурсов больше 4 МиБ.');
        }

        // ----------------------------------------------
        // 5. Формирование нормализованного ресурса
        // ----------------------------------------------

        return {
            path: normalizedPath,
            content: item.content,

            // Не добавляем encoding для UTF-8:
            // это сохраняет исходный формат объекта.
            ...(item.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
        };
    });

    // Сортируем ресурсы для получения
    // стабильного порядка хранения и сравнения.
    return resources.sort((a, b) => a.path.localeCompare(b.path));
}
