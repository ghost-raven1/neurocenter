import { BadRequestException, HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientErrorController } from '../client-error.controller';

/**
 * AD-O5 (res-obs 6.11): ClientErrorController — allowlist-нормализация client-репортов
 * и доставка в catalog POST /internal/error-events (events-конверт, internal token).
 */
const fetchMock = vi.hoisted(() => vi.fn());

function makeController(token: string | undefined, catalogUrl = 'http://catalog.test:4102') {
    const config = {
        get: (key: string) =>
            key === 'CATALOG_SERVICE_URL' ? catalogUrl : key === 'NEUROCENTER_INTERNAL_TOKEN' ? token : undefined,
    };
    return new ClientErrorController(config as never);
}
const okCatalog = { ok: true, status: 202, json: async () => ({ received: 1 }) };
function validBody(overrides: Record<string, unknown> = {}) {
    return {
        message: 'client-unhandled-rejection',
        component: 'NeurocenterShell',
        stackHint: 'frame-a\nframe-b',
        requestId: 'req-42',
        count: 3,
        ...overrides,
    };
}
const lastFetch = (): { url: string; init: RequestInit } => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [URL, RequestInit];
    return { url: String(url), init };
};

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okCatalog);
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ClientErrorController: allowlist и доставка (AD-O5/AD-O8)', () => {
    it('нормализует допустимый коалированный репорт и шлёт в каталог safe-событие', async () => {
        const controller = makeController('internal-token-1');
        await expect(controller.reportClientError(validBody())).resolves.toEqual({ ok: true });
        const { url, init } = lastFetch();
        expect(url).toBe('http://catalog.test:4102/internal/error-events');
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['x-neurocenter-internal']).toBe('internal-token-1');
        expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
        const sent = JSON.parse(String(init.body)) as { events: Array<Record<string, unknown>> };
        expect(sent.events).toEqual([
            {
                service: 'frontend',
                level: 'error',
                message: 'client-unhandled-rejection',
                requestId: 'req-42',
                stackHint: 'component: NeurocenterShell\nframe-a\nframe-b',
            },
        ]);
        // batch-meta (count) в stored-событие не попадает: колонки нет (схема 6.10)
        expect(sent.events[0].count).toBeUndefined();
    });

    it('без component кадры уходят как есть, без префикса', async () => {
        const controller = makeController('internal-token-1');
        await controller.reportClientError(validBody({ component: undefined }));
        const sent = JSON.parse(String(lastFetch().init.body)) as { events: Array<Record<string, unknown>> };
        expect(sent.events[0].stackHint).toBe('frame-a\nframe-b');
    });

    it.each([
        ['client-crash', 'не в allowlist'],
        ['CLIENT-UNHANDLED-REJECTION', 'case-sensitive'],
        ['', 'пустой'],
    ])('отклоняет message %s (%s) с 400 до доставки', async (message) => {
        const controller = makeController('internal-token-1');
        await expect(controller.reportClientError(validBody({ message }))).rejects.toBeInstanceOf(BadRequestException);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('отклоняет не-объект тела с 400', async () => {
        const controller = makeController('internal-token-1');
        await expect(controller.reportClientError('client-uncaught-error')).rejects.toBeInstanceOf(BadRequestException);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('component вне идентификатора отбрасывается (без 400)', async () => {
        const controller = makeController('internal-token-1');
        await expect(controller.reportClientError(validBody({ component: 'a b<script>' }))).resolves.toEqual({
            ok: true,
        });
        const sent = JSON.parse(String(lastFetch().init.body)) as { events: Array<Record<string, unknown>> };
        expect(sent.events[0].stackHint).toBe('frame-a\nframe-b');
    });

    it('requestId вне header-safe формата → background', async () => {
        const controller = makeController('internal-token-1');
        await controller.reportClientError(validBody({ requestId: 'req\nnewline' }));
        const sent = JSON.parse(String(lastFetch().init.body)) as { events: Array<Record<string, unknown>> };
        expect(sent.events[0].requestId).toBe('background');
    });

    it('stackHint дольше 4 КБ обрезается с пометкой', async () => {
        const controller = makeController('internal-token-1');
        await controller.reportClientError(validBody({ stackHint: 'a'.repeat(9000) }));
        const sent = JSON.parse(String(lastFetch().init.body)) as { events: Array<Record<string, unknown>> };
        const hint = String(sent.events[0].stackHint);
        expect(Buffer.byteLength(hint, 'utf8')).toBeLessThanOrEqual(4096);
        expect(hint.endsWith('…[truncated]')).toBe(true);
    });

    it('пустой stackHint → null', async () => {
        const controller = makeController('internal-token-1');
        await controller.reportClientError(validBody({ component: undefined, stackHint: '   \n\n ' }));
        const sent = JSON.parse(String(lastFetch().init.body)) as { events: Array<Record<string, unknown>> };
        expect(sent.events[0].stackHint).toBeNull();
    });

    it('чужие поля тела (payload/URL/cookies) в событие не попадают', async () => {
        const controller = makeController('internal-token-1');
        await controller.reportClientError(
            validBody({
                payload: { password: 'super-secret' },
                url: 'https://panel.example/api?secret=query-param',
                cookie: 'session=abc123',
            }),
        );
        const wire = JSON.parse(String(lastFetch().init.body)) as unknown;
        const wireString = JSON.stringify(wire);
        expect(wireString).not.toContain('super-secret');
        expect(wireString).not.toContain('query-param');
        expect(wireString).not.toContain('session=abc123');
    });
});

describe('ClientErrorController: best-effort доставка (OQ-2)', () => {
    it('сбой каталога → фиксированный 502 без раскрытия причины', async () => {
        fetchMock.mockRejectedValue(new Error('catalog socket hang up secret=leak'));
        const controller = makeController('internal-token-1');
        const error: HttpException = await controller.reportClientError(validBody()).catch((e) => e);
        expect(error.getStatus()).toBe(502);
        expect(JSON.stringify(error.getResponse())).not.toContain('secret=leak');
        expect(JSON.stringify(error.getResponse())).not.toContain('socket hang up');
    });

    it('каталог не принял (received≠1) → 502 с фиксированным телом', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({ received: 0 }) });
        const controller = makeController('internal-token-1');
        const error: HttpException = await controller.reportClientError(validBody()).catch((e) => e);
        expect(error.getStatus()).toBe(502);
        expect(error.getResponse()).toEqual({
            code: 'upstream-unavailable',
            message: 'Сервис временно недоступен. Повторите позже.',
        });
    });

    it('token не настроен → 502, внутренняя причина наружу не уходит', async () => {
        const controller = makeController(undefined);
        const error: HttpException = await controller.reportClientError(validBody()).catch((e) => e);
        expect(error.getStatus()).toBe(502);
        expect(error.getResponse()).toEqual({
            code: 'upstream-unavailable',
            message: 'Сервис временно недоступен. Повторите позже.',
        });
        expect(JSON.stringify(error.getResponse())).not.toContain('NEUROCENTER_INTERNAL_TOKEN');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('не-http адрес каталога → 502 без fetch', async () => {
        const controller = makeController('internal-token-1', 'ftp://catalog.test:4102');
        const error: HttpException = await controller.reportClientError(validBody()).catch((e) => e);
        expect(error.getStatus()).toBe(502);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('warn-лог доставки: только safe-поля, текст ошибки клиента не уходит', async () => {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED catalog secret=leak'));
        const written: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
            written.push(String(chunk));
            return true;
        }) as never);
        const controller = makeController('internal-token-1');
        await expect(controller.reportClientError(validBody())).rejects.toMatchObject({ status: 502 });
        spy.mockRestore();
        const warnLine = written.find((line) => line.includes('доставка в каталог не удалась'));
        expect(warnLine).toBeDefined();
        const parsed = JSON.parse(warnLine!) as Record<string, unknown>;
        expect(parsed.message).toBe('client-unhandled-rejection');
        expect(parsed.count).toBe(3);
        const line = JSON.stringify(parsed);
        expect(line).not.toContain('secret=leak');
        expect(line).not.toContain('ECONNREFUSED');
        // err — только name/code (AD-O8)
        expect(parsed.err).toEqual({ name: 'Error' });
    });
});
