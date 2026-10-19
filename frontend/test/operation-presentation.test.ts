import { describe, expect, it } from 'vitest';

import { formatOperationTime, operationLogLevel, operationProgressPercent, operationResourceLabel, operationStateOptions, operationTransfer, operationTypeLabel, shortOperationId } from '../src/modules/Operations/operationPresentation';

describe('Представление операций без выдуманных данных', () => {
    it('Фильтр содержит все шесть серверных состояний ровно по одному разу', () => {
        expect(operationStateOptions.map(option => option.value).sort()).toEqual([
            'CANCELLED', 'CONFLICT', 'FAILED', 'QUEUED', 'RUNNING', 'SUCCEEDED',
        ]);
    });

    it.each([[35.4, 35], [-1, 0], [180, 100], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0]])(
        'Процент %s отображается в пределах шкалы как %s', (value, displayed) => {
            expect(operationProgressPercent(value)).toBe(displayed);
        },
    );

    it('Не заменяет отсутствующую или некорректную дату текущим временем', () => {
        expect(formatOperationTime(null)).toBe('—');
        expect(formatOperationTime('не дата')).toBe('—');
        const at = '2026-10-18T03:20:15Z';
        expect(formatOperationTime(at)).toBe(new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).format(new Date(at)));
    });

    it('Не выдаёт нулевые счётчики за измеренную передачу и сохраняет небольшие значения в байтах', () => {
        expect(operationTransfer({ bytesDone: 0, bytesTotal: 0 })).toBeNull();
        expect(operationTransfer({ bytesDone: 17, bytesTotal: 100 })).toBe('17 Б / 100 Б');
        expect(operationTransfer({ bytesDone: 17, bytesTotal: 0 })).toBe('17 Б передано');
        expect(operationTransfer({ bytesDone: 1000, bytesTotal: 2000 })).toBe('1 КБ / 2 КБ');
    });

    it('Показывает известные подписи и не теряет неизвестные серверные коды', () => {
        expect(operationTypeLabel('INSTALL')).toBe('Установка');
        expect(operationResourceLabel('project')).toBe('Проект');
        expect(operationTypeLabel('FUTURE_TYPE')).toBe('FUTURE_TYPE');
        expect(operationResourceLabel('future-resource')).toBe('future-resource');
        expect(operationLogLevel('warn')).toEqual({ label: 'Внимание', color: 'warning' });
        expect(operationLogLevel('TRACE')).toEqual({ label: 'TRACE' });
    });

    it('Сокращает длинный идентификатор только для строки списка', () => {
        expect(shortOperationId('prj-catalog')).toBe('prj-catalog');
        expect(shortOperationId('12345678-1234-1234-1234-123456789abc')).toBe('12345678-123…');
    });
});
