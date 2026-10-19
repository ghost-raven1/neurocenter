import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelsService } from './models.service';
import { ModelHostingService } from './hosting.service';

/** Хостинг общий для площадки; назначение модели проекту не даёт прав на его остановку. */
@Controller('api/models')
export class ModelHostingController {
    constructor(private readonly models: ModelsService, private readonly hosting: ModelHostingService) {}
    @Get(':id/hosting')
    async status(@Param('id') id: string, @Req() request: Request) {
        return this.hosting.status(await this.models.getAccessible(id, request));
    }
    @Post(':id/hosting')
    async control(@Param('id') id: string, @Req() request: Request, @Body() input: unknown) {
        const actor = await this.models.requireMain(request);
        return this.hosting.control(id, input, actor);
    }
}
