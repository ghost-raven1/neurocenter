import { ServiceUnavailableException } from '@nestjs/common';
import { canonicalAccessRoute } from '../../../shared/access-route.cjs';
import type { IAccessClaims } from './access.model';
import type { IAccessRequest } from './access-policy';

interface ISkillReference { path: string; meta: { slug: string } }
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240
    && value.split('/').every(part => /^[a-z0-9][a-z0-9_-]*$/.test(part));
const isLegacy = (value: string): boolean => validPath(value) && !value.includes('/') && value !== 'project' && !value.startsWith('project-');

/** Служебный индекс разрешает старые slug без обхода gateway или области проекта. */
export async function fetchSkillReferences(): Promise<ISkillReference[]> {
    try {
        const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
        const base = new URL(process.env.SKILLS_SERVICE_URL || 'http://localhost:4200');
        if (!token || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) { throw new Error('Недоступна служебная конфигурация'); }
        const response = await fetch(new URL('/api/skills', base), { headers: { 'x-neurocenter-internal': token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (response.status !== 200) { throw new Error('Сервис скиллов недоступен'); }
        const index: unknown = await response.json();
        if (!Array.isArray(index) || index.some(item => !item || typeof item !== 'object' || !validPath(item.path)
            || !item.meta || typeof item.meta !== 'object' || typeof item.meta.slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(item.meta.slug))) {
            throw new Error('Некорректный индекс скиллов');
        }
        return index;
    } catch {
        throw new ServiceUnavailableException('Не удалось проверить доступ к скиллам. Повторите после восстановления сервиса скиллов.');
    }
}

/** Точный путь важнее прежнего slug; неоднозначность и чужие проектные каталоги не дают права. */
export function resolveSkillReference(reference: string, index: readonly ISkillReference[]): string | undefined {
    if (!validPath(reference)) { return undefined; }
    if (index.some(skill => skill.path === reference)) { return reference; }
    if (!isLegacy(reference)) { return undefined; }
    const candidates = new Set(index.filter(skill => {
        const scope = skill.path.split('/')[0];
        return scope !== 'project' && !scope.startsWith('project-')
            && (skill.meta.slug === reference || skill.path.split('/').at(-1) === reference);
    }).map(skill => skill.path));
    return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** Старые ссылки раскрываются только для чтения скиллов, не связывая остальные API с файловым сервисом. */
export async function resolveSkillReadClaims(claims: IAccessClaims, activeRole: string, request: IAccessRequest): Promise<IAccessClaims> {
    const route = canonicalAccessRoute(request.path);
    if (!claims.userRoles.includes(activeRole) || !['Разработчик', 'Наблюдатель'].includes(activeRole) || !['GET', 'HEAD'].includes(request.method.toUpperCase())
        || !route || !/^\/api\/skills(?:\/|$)/.test(route) || !claims.skillPaths.some(isLegacy)) { return claims; }
    const index = await fetchSkillReferences();
    return { ...claims, skillPaths: [...new Set(claims.skillPaths.flatMap(reference => {
        const resolved = isLegacy(reference) ? resolveSkillReference(reference, index) : reference;
        return resolved ? [resolved] : [];
    }))] };
}

/** Мост использует только старые ссылки из каталога выбранного проекта. */
export async function matchesLegacySkillReference(references: string[], path: string): Promise<boolean> {
    const legacy = references.filter(isLegacy);
    if (!legacy.length) { return false; }
    const index = await fetchSkillReferences();
    return legacy.some(reference => resolveSkillReference(reference, index) === path);
}
