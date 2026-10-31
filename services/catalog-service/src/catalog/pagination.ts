import { BadRequestException } from '@nestjs/common';

/** Неверные параметры отклоняются до SQL; размер страницы ограничен независимо от клиента. */
export function pagination(
    query: { page?: unknown; size?: unknown },
    defaultSize = 20,
): { page: number; size: number } {
    const integer = (value: unknown, fallback: number, label: string): number => {
        if (value === undefined) {
            return fallback;
        }
        const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
        if (!Number.isSafeInteger(number) || number < 1) {
            throw new BadRequestException(`Параметр ${label} должен быть положительным целым числом.`);
        }
        return number;
    };
    const page = integer(query.page, 1, 'page');
    const size = Math.min(100, integer(query.size, defaultSize, 'size'));
    if (!Number.isSafeInteger((page - 1) * size)) {
        throw new BadRequestException('Номер страницы слишком велик.');
    }
    return { page, size };
}
