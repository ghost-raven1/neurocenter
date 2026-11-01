import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelUsageService } from './model-usage.service';
import type { IModelUsageQuery, IModelUsageResult } from './model-usage.interfaces';

/** Access scope is recomputed from current server claims for every report. */
@Controller('api/model-usage')
export class ModelUsageController {
    constructor(private readonly usage: ModelUsageService) {}
    @Get() report(@Req() req: Request, @Query() query: IModelUsageQuery): Promise<IModelUsageResult> {
        return this.usage.report(req, query);
    }
}
