import { Body, Controller, Headers, Post } from '@nestjs/common';

import { assertInternal } from '../access/access.controller';
import { CatalogService } from '../catalog/catalog.service';

/** Файловый сервис повторяет доставку до подтверждения сохранённого аудита. */
@Controller('internal/skill-audit')
export class SkillAuditController {
    constructor(private readonly catalog: CatalogService) {}

    @Post('events')
    async events(@Headers('x-neurocenter-internal') token: string, @Body() input: unknown) {
        assertInternal(token);
        return this.catalog.recordSkillAuditEvents(input);
    }
}
