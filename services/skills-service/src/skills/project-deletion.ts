import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SKILL_JOURNAL_DIRECTORY } from '../storage/skill-journal';
import { SKILL_VERSIONS_DIRECTORY } from '../storage/skill-versions';
import type { ISkillsStorage } from '../storage/skills-storage.interface';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Строгая проверка ключа проекта: то же допустимое имя, что у скиллов, без «..» и слеши-трюков. */
export function projectKey(value: unknown): string {
    if (typeof value !== 'string' || !value.length || value.length > 240) {
        throw new BadRequestException('Некорректный идентификатор проекта.');
    }
    if (value.split('/').some((part) => !/^[a-z0-9][a-z0-9_-]*$/.test(part))) {
        throw new BadRequestException('Недопустимый идентификатор проекта.');
    }
    return value;
}

/**
 * Entry 5.11 (AD-D3): полное физическое удаление каталога скиллов проекта.
 *
 * Удаляются каталог `project-<key>` (вместе со всеми скиллами и ресурсами),
 * снимки версий `.neurocenter-skill-versions/<sha256(skillPath)>/` для каждого
 * скилла и журнал области `project-<key>` (защита от «воскрешения» незавершённой
 * синхронизации при старте). Терминальная операция: восстановления не предусмотрено.
 *
 * @returns {Promise<{deleted: boolean, skills: number}>} `deleted=false`, если каталог
 *   существовал, но был пуст (скиллов не было).
 */
export async function deleteProjectSkills(
    storage: Pick<ISkillsStorage, 'baseDir'>,
    value: unknown,
): Promise<{ deleted: boolean; skills: number }> {
    const key = projectKey(value);
    const projectDir = path.join(storage.baseDir, `project-${key}`);

    let info;
    try {
        info = await fs.stat(projectDir);
    } catch {
        throw new NotFoundException(`Каталог скиллов проекта отсутствует: ${key}`);
    }
    if (!info.isDirectory()) {
        throw new NotFoundException(`Каталог скиллов проекта отсутствует: ${key}`);
    }

    const skillPaths: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                skillPaths.push(path.relative(storage.baseDir, absolute).slice(0, -3).split(path.sep).join('/'));
            }
        }
    };
    await walk(projectDir);

    for (const skillPath of skillPaths) {
        await fs.rm(path.join(storage.baseDir, SKILL_VERSIONS_DIRECTORY, sha256(skillPath)), {
            recursive: true,
            force: true,
        });
    }
    // Журнал области: незавершённая синхронизация не должна поднять скилл обратно при старте.
    const scope = `project-${key}`.split('/')[0];
    await fs.rm(path.join(storage.baseDir, SKILL_JOURNAL_DIRECTORY, sha256(scope) + '.json'), { force: true });

    await fs.rm(projectDir, { recursive: true, force: true });
    return { deleted: skillPaths.length > 0, skills: skillPaths.length };
}
