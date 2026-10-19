import { describe, expect, it } from 'vitest';
import { fail, ok } from '../src/lib/stdio.js';

describe('Ответы MCP через stdio', () => {
    it('возвращает готовый JSON без повторного кодирования', () => {
        const payload = JSON.stringify({ ok: false, error: 'project-instance-unverified' });
        const result = ok(payload);
        expect(result.content).toEqual([ { type: 'text', text: payload } ]);
        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
            ok: false,
            error: 'project-instance-unverified',
        });
    });

    it('сохраняет готовый текст понятным читателю', () => {
        expect(ok('Папка уже подключена.').content).toEqual([
            { type: 'text', text: 'Папка уже подключена.' },
        ]);
    });

    it('сериализует структурированный объект один раз', () => {
        const payload = { ok: true, count: 2, path: 'Папка/проект' };
        const result = ok(payload);
        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(payload);
    });

    it('помечает ошибку и сохраняет экранирование её полей', () => {
        const result = fail('Не найден "проект"', 'строка\nподробности');
        expect(result.isError).toBe(true);
        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
            error: 'Не найден "проект"',
            detail: 'строка\nподробности',
        });
    });
});
