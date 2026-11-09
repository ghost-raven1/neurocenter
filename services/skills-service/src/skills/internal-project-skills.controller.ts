import { BadRequestException, Body, Controller, ForbiddenException, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { SKILLS_STORAGE } from '../storage/skills-storage.interface';
import type { ISkillsStorage } from '../storage/skills-storage.interface';
import { deleteProjectSkills } from './project-deletion';

/**
 * Entry 5.11 (AD-D3): внутренняя точка каскада удаления проекта.
 *
 * Публичный gateway не маршрутизирует internal; токен каталога не заменяется
 * параметрами браузера. Удаляет каталог скиллов проекта и снимки его версий.
 */
@Controller('internal/project-skills')
export class InternalProjectSkillsController {
    constructor(@Inject(SKILLS_STORAGE) private readonly storage: ISkillsStorage) {}

    private authorize(req: Request): void {
        const expected = Buffer.from(process.env.NEUROCENTER_INTERNAL_TOKEN ?? ''),
            header = req.headers['x-neurocenter-internal'];
        const supplied = Buffer.from(typeof header === 'string' ? header : '');
        if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            throw new ForbiddenException('Требуется внутренний доступ каталога.');
        }
    }

    private actor(value: unknown): string {
        if (typeof value !== 'string' || !value.length || value.length > 254 || /[\x00-\x1f]/.test(value)) {
            throw new BadRequestException('Требуется исполнитель удаления.');
        }
        return value;
    }

    @Post('delete')
    async delete(@Req() req: Request, @Body() body: { projectId?: unknown; actor?: unknown }) {
        this.authorize(req);
        const actor = this.actor(body?.actor);
        return deleteProjectSkills(this.storage, body?.projectId).then((result) => ({
            ...result,
            actor,
        }));
    }
}
