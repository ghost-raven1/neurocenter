/**
 * Форматирует количество байтов в человекочитаемое значение (ГБ/МБ/КБ).
 *
 * @param {number} bytes - количество байтов (десятичные единицы)
 * @returns человекочитаемая строка
 */
export const formatBytes = (bytes: number): string => {
    if (!bytes || bytes < 0) {
        return '0';
    }

    const gb = bytes / 1000000000;

    if (gb >= 1) {
        return `${gb.toFixed(2)} ГБ`;
    }

    const mb = bytes / 1000000;

    if (mb >= 1) {
        return `${mb.toFixed(1)} МБ`;
    }

    return `${Math.round(bytes / 1000)} КБ`;
};

/**
 * Форматирует дату (ISO) в локальное представление ДД.ММ.ГГГГ.
 *
 * @param {string} iso - ISO-дата
 * @returns строка даты или пусто
 */
export const formatDate = (iso: string): string => {
    if (!iso) {
        return '';
    }

    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        return iso;
    }

    return date.toLocaleDateString('ru-RU');
};
