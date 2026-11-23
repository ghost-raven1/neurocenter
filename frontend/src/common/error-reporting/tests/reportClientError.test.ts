/**
 * AD-O5 (res-obs 6.11): reportClientError — allowlist-сбор, коаляция, requestId.
 *
 * Ключевой ассерт (тест «в» плана): payload/URL/cookies из error-объекта
 * НЕ попадают в POST-тело — в репорте только message(фикс)/component/stackHint/requestId/count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    basePost: vi.fn(),
    lastRequestId: { value: null as string | null },
}));

vi.mock('../../../core/api/base', () => ({
    default: { post: mocks.basePost },
    getLastRequestId: () => mocks.lastRequestId.value,
}));

import { flushClientErrorReport, reportClientError } from '../reportClientError';
import { buildClientStackHint } from '../clientStackHint';

const bodyOf = (callIndex = 0): Record<string, unknown> =>
    mocks.basePost.mock.calls[callIndex][1] as Record<string, unknown>;

beforeEach(() => {
    vi.useFakeTimers();
    mocks.basePost.mockReset();
    mocks.basePost.mockResolvedValue({ status: 202 });
    mocks.lastRequestId.value = null;
});

afterEach(() => {
    vi.useRealTimers();
    void flushClientErrorReport();
});

describe('reportClientError: allowlist-сбор (AD-O8/AD-19)', () => {
    it('payload/URL/cookies из error не попадают в POST-тело', async () => {
        const error = new Error('password=super-secret token=jwt-secret');
        error.stack =
            'Error: password=super-secret token=jwt-secret\n' +
            '    at submit (https://panel.example/static/app.js:10:5)\n' +
            '    at inner (app.js:20:9)';
        Object.assign(error, {
            data: { password: 'super-secret', cookie: 'session=abc123' },
            url: 'https://panel.example/api/projects?secret=query-param',
        });

        reportClientError({
            kind: 'uncaught',
            component: 'LoginForm',
            stackHint: buildClientStackHint(error),
        });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(mocks.basePost).toHaveBeenCalledTimes(1);
        const [url, body] = mocks.basePost.mock.calls[0];
        expect(url).toBe('/api/errors/client');
        // Строго allowlist-ключи — ничего больше.
        expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
            'component',
            'count',
            'message',
            'requestId',
            'stackHint',
        ]);
        const wire = JSON.stringify(body);
        expect(wire).not.toContain('super-secret');
        expect(wire).not.toContain('jwt-secret');
        expect(wire).not.toContain('query-param');
        expect(wire).not.toContain('session=abc123');
        expect(wire).not.toContain('password=');
    });

    it('POST-тело — только safe-поля: фикс-классификатор, кадры, requestId, count', async () => {
        mocks.lastRequestId.value = 'req-123';
        const error = new Error('whatever');
        error.stack = 'Error: whatever\n    at outer (app.js:1:1)';

        reportClientError({ kind: 'rejection', stackHint: buildClientStackHint(error) });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(mocks.basePost).toHaveBeenCalledTimes(1);
        const body = bodyOf();
        expect(body).toEqual({
            count: 1,
            message: 'client-unhandled-rejection',
            component: null,
            stackHint: 'at outer (app.js:1:1)',
            requestId: 'req-123',
        });
    });
});

describe('reportClientError: коаляция (1 репорт/мин, с числом)', () => {
    it('три ошибки за окно — один репорт с count=3', async () => {
        const makeError = (frame: string) => {
            const error = new Error(`m-${frame}`);
            error.stack = `Error: m-${frame}\n    at ${frame} (app.js:1:1)`;
            return error;
        };
        reportClientError({ kind: 'uncaught', stackHint: buildClientStackHint(makeError('f1')) });
        vi.advanceTimersByTime(30_000);
        reportClientError({ kind: 'rejection', stackHint: buildClientStackHint(makeError('f2')) });
        vi.advanceTimersByTime(10_000);
        reportClientError({ kind: 'render', component: 'App', stackHint: buildClientStackHint(makeError('f3')) });

        expect(mocks.basePost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000); // t=70s — окно 60s с первой ошибки

        expect(mocks.basePost).toHaveBeenCalledTimes(1);
        const body = bodyOf();
        expect(body.count).toBe(3);
        // Первый репорт окна задаёт классификатор/кадры/заголовок.
        expect(body.message).toBe('client-uncaught-error');
        expect(body.stackHint).toBe('at f1 (app.js:1:1)');
        expect(body.requestId).toBe('background');
    });

    it('коаляция не дублирует доставку в пределах окна', async () => {
        reportClientError({ kind: 'uncaught', stackHint: 'at a (b.js:1:1)' });
        reportClientError({ kind: 'uncaught', stackHint: 'at c (d.js:1:1)' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.basePost).toHaveBeenCalledTimes(1);
    });

    it('пустая очередь — POST нет', async () => {
        await flushClientErrorReport();
        expect(mocks.basePost).not.toHaveBeenCalled();
    });
});

describe('reportClientError: requestId и best-effort', () => {
    it('X-Request-ID из последнего ответа; нет/невалидный — background', async () => {
        mocks.lastRequestId.value = 'abc123def';
        reportClientError({ kind: 'uncaught', stackHint: 'at a (b.js:1:1)' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bodyOf().requestId).toBe('abc123def');

        mocks.lastRequestId.value = null;
        reportClientError({ kind: 'uncaught', stackHint: 'at a (b.js:1:1)' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bodyOf(1).requestId).toBe('background');

        mocks.lastRequestId.value = '../etc/passwd; drop table';
        reportClientError({ kind: 'uncaught', stackHint: 'at a (b.js:1:1)' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bodyOf(2).requestId).toBe('background');
    });

    it('429/сеть — best-effort: исключение наружу не уходит', async () => {
        mocks.basePost.mockRejectedValue(new Error('429 too many requests'));
        reportClientError({ kind: 'uncaught', stackHint: 'at a (b.js:1:1)' });
        // Если catch внутри flushClientErrorReport не работал бы, отклонённый
        // promise вылез бы сюда (unhandled rejection) — тест бы упал сам.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.basePost).toHaveBeenCalledTimes(1);
    });

    it('component вне идентификатора отбрасывается', async () => {
        reportClientError({ kind: 'render', component: 'a b<script>', stackHint: 'at a (b.js:1:1)' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bodyOf().component).toBeNull();

        reportClientError({ kind: 'render', component: 'Model_Chat-2', stackHint: 'at a (b.js:1:1)' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bodyOf(1).component).toBe('Model_Chat-2');
    });

    it('несуществующий kind игнорируется', async () => {
        reportClientError({ kind: 'custom' as never, stackHint: 'at a (b.js:1:1)' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.basePost).not.toHaveBeenCalled();
    });

    it('stackHint trunc до 4 КБ в POST-теле', async () => {
        const longHint = Array.from({ length: 40 }, (_, i) => `at f${i}() at ${'x'.repeat(300)}.js:${i}:1`).join('\n');
        reportClientError({ kind: 'uncaught', stackHint: longHint });
        await vi.advanceTimersByTimeAsync(60_000);
        const hint = String(bodyOf().stackHint);
        expect(new TextEncoder().encode(hint).byteLength).toBeLessThanOrEqual(4096 + 20);
        expect(hint.endsWith('…[truncated]')).toBe(true);
    });
});
