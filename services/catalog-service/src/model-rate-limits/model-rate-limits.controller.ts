import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelRateLimitsService } from './model-rate-limits.service';
import type { IModelRateLimitInput, IModelRateLimitView } from './model-rate-limits.interfaces';

/** Limits are independent from provider credentials and immutable model pins. */
@Controller('api/models')
export class ModelRateLimitsController {
    constructor(private readonly limits: ModelRateLimitsService) {}
    @Get(':id/rate-limit')
    read(@Req() req: Request, @Param('id') id: string): Promise<IModelRateLimitView> {
        return this.limits.read(req, id);
    }
    @Put(':id/rate-limit')
    save(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() value: IModelRateLimitInput,
    ): Promise<IModelRateLimitView> {
        return this.limits.save(req, id, value);
    }
}
