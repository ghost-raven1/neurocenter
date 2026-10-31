import { renderSkillInstruction } from '../../../shared/skill-package.cjs';
import { BadRequestException } from '@nestjs/common';
import type { ISkillCreateRequest, ISkillMeta } from './skills.model';
import { validateResources } from './skill-resources';
import { normalizeDependencyPins, type IDependencyPin } from '../../../shared/dependency-pins.cjs';

/** Ошибка входных зависимостей остаётся понятным ответом API. */
export function skillDependencyPins(value: unknown): IDependencyPin[] {
    try {
        return normalizeDependencyPins(value);
    } catch (error) {
        throw new BadRequestException((error as Error).message);
    }
}

/** Stored legacy requirements stay readable; a new publication must replace them explicitly. */
export function assertSkillDependencyReplacement(
    previous: Pick<ISkillMeta, 'mcp' | 'plugins'>,
    replacement?: Partial<ISkillMeta>,
): void {
    if (!previous.mcp.length && !previous.plugins.length) return;
    if (
        !replacement ||
        !Object.prototype.hasOwnProperty.call(replacement, 'dependencies') ||
        !Array.isArray(replacement.mcp) ||
        replacement.mcp.length ||
        !Array.isArray(replacement.plugins) ||
        replacement.plugins.length
    ) {
        throw new BadRequestException(
            'Замените требования по имени явно: очистите mcp и plugins и укажите точные dependencies (или явно пустой список).',
        );
    }
}

/** Shared normalized payload projection; reading a historical record does not approve a new write. */
export function skillPublicationMeta(meta: Partial<ISkillMeta>) {
    const dependencies = skillDependencyPins(meta.dependencies);
    return {
        description: meta.description?.trim(),
        tags: [...new Set(meta.tags ?? [])],
        mcp: [...new Set(meta.mcp ?? [])],
        plugins: [...new Set(meta.plugins ?? [])],
        specialization: meta.specialization,
        ...(dependencies.length ? { dependencies } : {}),
    };
}

/** Строгая проверка пути: удалять «..» и тем самым менять область доступа нельзя. */
export function skillPath(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.length > 240 ||
        (value && value.split('/').some((part) => !/^[a-z0-9][a-z0-9_-]*$/.test(part)))
    ) {
        throw new BadRequestException(
            'Недопустимый путь скилла. Используйте относительные имена через / без точек и обратных слешей.',
        );
    }
    return value;
}

/** Проверяет инструкцию и ресурсы до публикации версии. */
export function validateSkillCreate(value: ISkillCreateRequest): ISkillCreateRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException('Передайте данные скилла.');
    }
    const path = skillPath(value.path);
    if (typeof value.slug !== 'string' || value.slug.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value.slug)) {
        throw new BadRequestException('Идентификатор скилла: до 64 строчных латинских букв, цифр и одиночных дефисов.');
    }
    if (
        typeof value.name !== 'string' ||
        !value.name.trim() ||
        value.name.trim().length > 128 ||
        /[\x00-\x1f\x7f]/.test(value.name)
    ) {
        throw new BadRequestException('Укажите название скилла до 128 символов.');
    }
    if (
        typeof value.body !== 'string' ||
        !value.body.trim() ||
        value.body.includes('\0') ||
        Buffer.byteLength(value.body, 'utf8') > 1024 * 1024
    ) {
        throw new BadRequestException('Добавьте непустую текстовую инструкцию до 1 МиБ.');
    }
    if (value.meta !== undefined && (!value.meta || typeof value.meta !== 'object' || Array.isArray(value.meta))) {
        throw new BadRequestException('Метаданные скилла должны быть объектом.');
    }
    const meta = value.meta ?? {};
    const dependencies = skillDependencyPins(meta.dependencies);
    if (path.split('/')[0] === 'common' && (typeof meta.description !== 'string' || !meta.description.trim())) {
        throw new BadRequestException('Для общего магазина заполните описание скилла.');
    }
    if (
        meta.description !== undefined &&
        (typeof meta.description !== 'string' || meta.description.length > 1024 || meta.description.includes('\0'))
    ) {
        throw new BadRequestException('Описание скилла: до 1024 символов.');
    }
    for (const key of ['tags', 'mcp', 'plugins'] as const) {
        const list = meta[key];
        if (
            list !== undefined &&
            (!Array.isArray(list) ||
                list.length > 20 ||
                list.some(
                    (item) => typeof item !== 'string' || !item.trim() || item.length > 128 || /[\x00-\x1f]/.test(item),
                ))
        ) {
            throw new BadRequestException(`Поле ${key}: до 20 непустых строк.`);
        }
    }
    if (meta.mcp?.length || meta.plugins?.length) {
        throw new BadRequestException(
            'Требования MCP/плагинов по имени не публикуются. Укажите точные dependencies: ID, версия и SHA-256; mcp и plugins должны быть пустыми.',
        );
    }
    if (
        meta.specialization !== undefined &&
        (typeof meta.specialization !== 'string' || meta.specialization.length > 256)
    ) {
        throw new BadRequestException('Некорректная специализация скилла.');
    }
    if (
        Buffer.byteLength(
            renderSkillInstruction(
                { slug: value.slug, description: meta.description, mcp: meta.mcp, plugins: meta.plugins },
                value.body,
            ),
            'utf8',
        ) >
        1024 * 1024
    ) {
        throw new BadRequestException('Инструкция вместе с метаданными SKILL.md должна помещаться в 1 МиБ.');
    }
    return {
        ...value,
        resources: validateResources(value.resources),
        path,
        name: value.name.trim().normalize('NFC'),
        meta: skillPublicationMeta({ ...meta, dependencies }),
    };
}
