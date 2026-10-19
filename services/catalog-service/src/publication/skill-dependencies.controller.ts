import { Body, Controller, Headers, Post } from '@nestjs/common';

import { assertInternal } from '../access/access.controller';
import { CatalogService } from '../catalog/catalog.service';

/** Файловый сервис закрепляет зависимости до изменения скилла. */
@Controller('internal/skill-dependencies')
export class SkillDependenciesController {
    constructor(private readonly catalog: CatalogService) {}

    @Post('reserve')
    async reserve(@Headers('x-neurocenter-internal') token: string, @Body() input: unknown) {
        assertInternal(token);
        return { ok: true, ...await this.catalog.reserveSkillDependencies(input) };
    }
}
