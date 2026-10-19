import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query, Req } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { SKILLS_STORAGE, type ISkillsStorage } from '../storage/skills-storage.interface';
import { scanSkillDependencyUsage } from '../storage/skill-dependency-usage';

/** Служебная проверка ссылок не раскрывает тексты, пути и метаданные скиллов. */
@Controller('internal/skill-dependencies')
export class SkillDependenciesController {
    constructor(@Inject(SKILLS_STORAGE) private readonly storage: ISkillsStorage) {}

    @Get('usage')
    async usage(@Req() request: Request, @Query('assetId') assetId: string): Promise<{ inUse: boolean }> {
        const expected = Buffer.from(process.env.NEUROCENTER_INTERNAL_TOKEN || '');
        const supplied = request.headers['x-neurocenter-internal'];
        const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
        if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            throw new ForbiddenException('Требуется внутренний доступ.');
        }
        if (typeof assetId !== 'string' || !/^ai-plug-[a-z0-9][a-z0-9_-]{0,119}$/.test(assetId)) {
            throw new BadRequestException('Укажите ID MCP или плагина.');
        }
        return { inUse: await scanSkillDependencyUsage(this.storage.baseDir, assetId) };
    }
}
