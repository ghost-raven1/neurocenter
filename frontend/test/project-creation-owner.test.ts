import { describe, expect, it, vi } from 'vitest';
import { createAuthRequestOwner } from '../src/features/UserBlock/authRequestOwner';
import { submitProjectCreation } from '../src/modules/Projects/projectCreation';

function setup() {
    let scope = 'Алексей:администратор';
    const owner = createAuthRequestOwner(scope, () => scope);
    owner.activate();
    let resolve!: (value: { id: string }) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<{ id: string }>((done, fail) => { resolve = done; reject = fail; });
    const create = vi.fn().mockReturnValue(pending);
    const onCreated = vi.fn();
    const onError = vi.fn();
    const submit = () => submitProjectCreation({ create, onCreated, onError, isCurrent: owner.captureOwner() });
    return { owner, create, onCreated, onError, submit, resolve, reject, change: (next: string) => { scope = next; } };
}

describe('Создание проекта и владелец формы', () => {
    it.each(['', 'другой аккаунт', 'Алексей:наблюдатель'])('Не уведомляет, не сбрасывает форму и не перенаправляет после смены владельца: %s', async scope => {
        const test = setup();
        const request = test.submit();
        test.change(scope);
        test.resolve({ id: 'проект-прежнего-аккаунта' });
        await request;
        expect(test.onCreated).not.toHaveBeenCalled();
        expect(test.onError).not.toHaveBeenCalled();
    });

    it('Не показывает позднюю ошибку новой сессии', async () => {
        const test = setup();
        const request = test.submit();
        test.change('другой аккаунт');
        test.reject(new Error('Отказ'));
        await request;
        expect(test.onCreated).not.toHaveBeenCalled();
        expect(test.onError).not.toHaveBeenCalled();
    });

    it('Завершает создание для действующего владельца', async () => {
        const test = setup();
        const request = test.submit();
        test.resolve({ id: 'новый-проект' });
        await request;
        expect(test.onCreated).toHaveBeenCalledExactlyOnceWith('новый-проект');
        expect(test.onError).not.toHaveBeenCalled();
    });

    it('Сохраняет отказ для текущей формы, позволяя повторить создание', async () => {
        const test = setup();
        const request = test.submit();
        const error = new Error('Сервис недоступен');
        test.reject(error);
        await request;
        expect(test.onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(test.onCreated).not.toHaveBeenCalled();
    });

    it('Закрытая форма не начинает запись и не принимает ответ после повторной активации', async () => {
        const test = setup();
        const request = test.submit();
        test.owner.dispose(); test.owner.activate();
        test.resolve({ id: 'проект' });
        await request;
        expect(test.onCreated).not.toHaveBeenCalled();
        test.owner.dispose();
        await test.submit();
        expect(test.create).toHaveBeenCalledTimes(1);
    });
});
