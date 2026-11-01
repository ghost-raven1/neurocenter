import { describe, expect, it } from 'vitest';
import { requireRagSuccess } from '../ragResult';

describe('requireRagSuccess', () => {
    it('returns a successful receipt including operation-specific fields', () => {
        const receipt = { ok: true, restoredFiles: 12 };
        expect(requireRagSuccess(receipt)).toEqual(receipt);
    });

    it.each([
        ['empty-source', 'На сервере пока нет данных проекта. Сначала отправьте локальную базу знаний.'],
        ['store-not-found', 'Локальная база знаний не найдена. Проверьте папку проекта и создайте индекс в OpenCode.'],
        ['incomplete-source', 'Скачивание не завершено. Повторите попытку: локальные данные сохранены.'],
    ])('explains the recovery action for %s even after HTTP success', (error, message) => {
        expect(() => requireRagSuccess({ ok: false, error, message: 'Raw transport detail' })).toThrow(message);
    });

    it('preserves a server explanation for an unknown failure', () => {
        expect(() =>
            requireRagSuccess({ ok: false, error: 'new-error', message: 'Повторите после подключения моста' }),
        ).toThrow('Повторите после подключения моста');
    });

    it('provides a recovery instruction when the server has no explanation', () => {
        expect(() => requireRagSuccess({ ok: false })).toThrow(
            'Операция с базой знаний не выполнена. Проверьте состояние проекта и повторите попытку.',
        );
    });
});
