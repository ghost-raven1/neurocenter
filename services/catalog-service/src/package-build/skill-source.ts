import { BadRequestException } from '@nestjs/common';
import { parseSkillSource, type SkillSourceFile } from '../../../shared/skill-source.cjs';

const yaml = require('js-yaml') as { load(text: string, options: { schema: unknown }): unknown; JSON_SCHEMA: unknown };
/** The same strict source parser is used by GitHub metadata, local validation and the queued build. */
export function inspectSkillSource(
    files: SkillSourceFile[],
    overrides?: { name?: string; description?: string; entrypoint?: string; metadataOnly?: boolean },
) {
    try {
        return parseSkillSource(files, overrides, (text) => yaml.load(text, { schema: yaml.JSON_SCHEMA }));
    } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : 'Некорректный SKILL.md.');
    }
}
