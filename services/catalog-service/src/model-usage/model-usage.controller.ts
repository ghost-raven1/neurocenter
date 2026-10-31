import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelUsageService } from './model-usage.service';
import type { ModelUsageQuery, ModelUsageResult } from './model-usage.types';

/** Access scope is recomputed from current server claims for every report. */
@Controller('api/model-usage')
export class ModelUsageController {
    constructor(private readonly usage: ModelUsageService) {}
    @Get() report(@Req() req: Request, @Query() query: ModelUsageQuery): Promise<ModelUsageResult> {
        return this.usage.report(req, query);
    }
}
