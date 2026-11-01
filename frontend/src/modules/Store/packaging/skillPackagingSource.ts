import { JSON_SCHEMA, load } from 'js-yaml';
import { parseSkillSource } from '../../../../../services/shared/skill-source.mjs';
import type { IPackagingFile } from './interfaces';

/** Предпросмотр использует те же правила SKILL.md, что и серверная упаковка. */
export function skillPackagingSource(
    files: IPackagingFile[],
    overrides?: { name?: string; description?: string; entrypoint?: string },
): { name?: string; description?: string; error?: string } | undefined {
    if (!files.some((file) => /(?:^|\/)skill\.md$/i.test(file.path))) return;
    try {
        const parsed = parseSkillSource(files, overrides, (value) => load(value, { schema: JSON_SCHEMA }));
        return { name: parsed.name, description: parsed.description };
    } catch (error) {
        return { error: error instanceof Error ? error.message : 'Не удалось проверить SKILL.md.' };
    }
}
