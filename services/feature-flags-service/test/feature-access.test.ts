import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { FeatureAccess, assertFeatureInternal } from '../src/access/feature-access';

const email = 'admin@example.invalid';
const request = (activeRole = 'Главный админ', account = email) => ({ headers: { 'x-neurocenter-internal': 'flags-test-token',
    'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: account, activeRole })) } }) as unknown as Request;
const response = (roles: string[] = ['Главный админ']) => new Response(JSON.stringify({ email, userRoles: roles }), { headers: { 'content-type': 'application/json' } });
const previous = { token: process.env.NEUROCENTER_INTERNAL_TOKEN, catalog: process.env.CATALOG_SERVICE_URL };

describe('Свежие права управления переключателями', () => {
    let fetcher: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        process.env.NEUROCENTER_INTERNAL_TOKEN = 'flags-test-token'; process.env.CATALOG_SERVICE_URL = 'http://127.0.0.1:4100';
        fetcher = vi.fn(async () => response()); vi.stubGlobal('fetch', fetcher);
    });
    afterEach(() => {
        vi.unstubAllGlobals(); vi.useRealTimers();
        for (const [key, value] of [['NEUROCENTER_INTERNAL_TOKEN', previous.token], ['CATALOG_SERVICE_URL', previous.catalog]]) {
            if (value === undefined) { delete process.env[key!]; } else { process.env[key!] = value; }
        }
    });

    it('Проверяет общий секрет, пользователя и реальное назначение активной роли', async () => {
        const access = new FeatureAccess();
        expect(await access.requireMain(request())).toBe(email);
        const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
        expect(url.pathname).toBe('/internal/access/profile'); expect(url.searchParams.get('email')).toBe(email);
        expect(options.redirect).toBe('error'); expect(options.headers).toEqual({ 'x-neurocenter-internal': 'flags-test-token' });
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it.each(['Админ проекта', 'Разработчик', 'Наблюдатель'])('Вычисленные значения доступны роли %s, управление недоступно', async role => {
        fetcher.mockImplementation(async () => response([role]));
        const access = new FeatureAccess();
        expect(await access.actor(request(role))).toEqual({ email, activeRole: role });
        await expect(access.requireMain(request(role))).rejects.toMatchObject({ status: 403 });
    });

    it('Отозванная роль не продолжает работать в той же сессии', async () => {
        const access = new FeatureAccess();
        expect(await access.requireMain(request())).toBe(email);
        fetcher.mockImplementation(async () => response(['Наблюдатель']));
        await expect(access.requireMain(request())).rejects.toMatchObject({ status: 403 });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('Служебный секрет и корректный actor обязательны до межсервисного запроса', async () => {
        const access = new FeatureAccess();
        for (const token of [undefined, '', 'short', ['flags-test-token']]) { expect(() => assertFeatureInternal(token)).toThrow(); }
        for (const actor of ['%invalid', 'null', '[]', encodeURIComponent(JSON.stringify({ email, activeRole: 'admin' }))]) {
            const req = request(); req.headers['x-bridge-actor'] = actor;
            await expect(access.actor(req)).rejects.toMatchObject({ status: 403 });
        }
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('Отключённая учётная запись даёт отказ, ошибки сервиса не открывают доступ', async () => {
        const access = new FeatureAccess();
        fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
        await expect(access.actor(request())).rejects.toMatchObject({ status: 403 });
        fetcher.mockRejectedValueOnce(new Error('postgresql://name:secret@example.invalid/catalog'));
        const failure = await access.actor(request()).catch(error => error);
        expect(failure.status).toBe(503); expect(failure.message).not.toContain('secret');
        fetcher.mockResolvedValueOnce(new Response('', { status: 500 }));
        await expect(access.actor(request())).rejects.toMatchObject({ status: 503 });
    });

    it.each(['not-json', 'null', '{"email":"other@example.invalid","userRoles":["Главный админ"]}', '{"email":"admin@example.invalid","userRoles":["admin"]}'])('Неподтверждённый профиль закрывает доступ: %s', body => {
        fetcher.mockImplementation(async () => new Response(body));
        return expect(new FeatureAccess().requireMain(request())).rejects.toMatchObject({ status: 503 });
    });

    it('Слишком большой ответ каталога ограничен до разбора JSON', async () => {
        fetcher.mockImplementation(async () => new Response('x'.repeat(1024 * 1024 + 1)));
        await expect(new FeatureAccess().actor(request())).rejects.toMatchObject({ status: 503 });
    });

    it('Проверка прав прекращается через пять секунд', async () => {
        vi.useFakeTimers();
        // AbortSignal.timeout использует собственные часы Node; проверяем выданный ограниченный сигнал без ожидания сети.
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
        fetcher.mockImplementation(async (_url, options) => { options.signal.throwIfAborted(); return response(); });
        await expect(new FeatureAccess().actor(request())).rejects.toMatchObject({ status: 503 });
        expect(timeout).toHaveBeenCalledWith(5000); timeout.mockRestore();
    });
});
