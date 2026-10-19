import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const roles = ['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель'];
export interface IFeatureActor { email: string; activeRole: string }
const unavailable = () => new ServiceUnavailableException('Не удалось подтвердить действующие права. Повторите запрос после восстановления сервиса доступа.');

/** Общий секрет проверяется без сравнения открытых строк; пользовательский actor не заменяет gateway. */
export function assertFeatureInternal(value: unknown): void {
    const expected = process.env.NEUROCENTER_INTERNAL_TOKEN;
    if (!expected || typeof value !== 'string' || Buffer.byteLength(value) !== Buffer.byteLength(expected)
        || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) { throw new ForbiddenException('Запрос должен пройти через авторизованный шлюз.'); }
}

function catalogUrl(): string {
    let url: URL;
    try { url = new URL(process.env.CATALOG_SERVICE_URL || 'http://127.0.0.1:4100'); }
    catch { throw new Error('Некорректный адрес сервиса доступа.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Адрес сервиса доступа должен быть HTTP URL без пути и секретов.');
    }
    return url.origin;
}

/** Профиль читается заново: отзыв платформенных прав действует без повторного входа. */
@Injectable()
export class FeatureAccess {
    private readonly base = catalogUrl();
    private readonly request = globalThis.fetch;

    async actor(req: Request, mainOnly = false): Promise<IFeatureActor> {
        assertFeatureInternal(req.headers['x-neurocenter-internal']);
        let actor: unknown;
        try { actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null'))); }
        catch { throw new ForbiddenException('Нужна действующая роль пользователя.'); }
        if (!actor || typeof actor !== 'object' || Array.isArray(actor)) { throw new ForbiddenException('Нужна действующая роль пользователя.'); }
        const candidate = actor as Record<string, unknown>;
        if (typeof candidate.email !== 'string' || candidate.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(candidate.email)
            || typeof candidate.activeRole !== 'string' || !roles.includes(candidate.activeRole)) { throw new ForbiddenException('Нужна действующая роль пользователя.'); }
        const email = candidate.email.toLowerCase();
        const profile = await this.profile(email);
        if (!profile.roles.includes(candidate.activeRole) || mainOnly && candidate.activeRole !== 'Главный админ') {
            throw new ForbiddenException(mainOnly ? 'Управлять переключателями может главный администратор.' : 'Активная роль больше не назначена пользователю.');
        }
        return { email: profile.email, activeRole: candidate.activeRole };
    }

    async requireMain(req: Request): Promise<string> { return (await this.actor(req, true)).email; }

    private async profile(email: string): Promise<{ email: string; roles: string[] }> {
        const url = new URL('/internal/access/profile', this.base); url.searchParams.set('email', email);
        try {
            const response = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(5000),
                headers: { 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '' } });
            if (response.status === 403) { await response.body?.cancel(); throw new ForbiddenException('Учётная запись отключена или доступ отозван.'); }
            if (!response.ok || !response.body) { await response.body?.cancel(); throw unavailable(); }
            let size = 0; const chunks: Uint8Array[] = [];
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                size += chunk.length;
                if (size > 1024 * 1024) { throw unavailable(); }
                chunks.push(chunk);
            }
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> | null;
            if (!data || Array.isArray(data) || data.email !== email || !Array.isArray(data.userRoles)
                || data.userRoles.length > roles.length || data.userRoles.some(role => typeof role !== 'string' || !roles.includes(role))) { throw unavailable(); }
            return { email, roles: data.userRoles as string[] };
        } catch (error) {
            if (error instanceof ForbiddenException) { throw error; }
            throw unavailable();
        }
    }
}
