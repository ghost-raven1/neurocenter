import { describe, expect, it } from 'vitest';
import { createAuthRequestOwner } from '../src/features/UserBlock/authRequestOwner';

describe('Владелец незавершённой формы', () => {
    it('Разрешает завершение только активному владельцу и сохраняет его при обычном обновлении сессии', () => {
        let scope = 'A';
        const owner = createAuthRequestOwner('A', () => scope);
        owner.activate();
        const isCurrent = owner.captureOwner();
        expect(isCurrent()).toBe(true);
        scope = 'A';
        expect(isCurrent()).toBe(true);
    });

    it('Отвергает ответ сразу после смены пользователя или прав, до cleanup React', () => {
        let scope = 'A';
        const owner = createAuthRequestOwner('A', () => scope);
        owner.activate();
        const isCurrent = owner.captureOwner();
        scope = 'B';
        expect(isCurrent()).toBe(false);
        expect(owner.captureOwner()()).toBe(false);
    });

    it('Не оживляет старый запрос после размонтирования и повторной активации той же формы', () => {
        const owner = createAuthRequestOwner('A', () => 'A');
        owner.activate();
        const old = owner.captureOwner();
        owner.dispose();
        owner.activate();
        expect(old()).toBe(false);
        expect(owner.captureOwner()()).toBe(true);
    });

    it('Запрещает запись без сессии и до активации формы', () => {
        const empty = createAuthRequestOwner('', () => '');
        empty.activate();
        expect(empty.captureOwner()()).toBe(false);
        const inactive = createAuthRequestOwner('A', () => 'A');
        expect(inactive.captureOwner()()).toBe(false);
    });

    it('Останавливает оставшиеся назначения и callback, когда владелец сменился во время первой записи', async () => {
        let scope = 'A';
        const owner = createAuthRequestOwner('A', () => scope);
        owner.activate();
        const isCurrent = owner.captureOwner();
        const writes: string[] = [];
        let callbacks = 0;
        for (const project of ['первый', 'второй']) {
            if (!isCurrent()) { break; }
            writes.push(project);
            await Promise.resolve().then(() => { scope = 'B'; });
        }
        if (isCurrent()) { callbacks += 1; }
        expect(writes).toEqual(['первый']);
        expect(callbacks).toBe(0);
    });
});
