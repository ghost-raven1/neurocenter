import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AssetSourcesService } from './asset-sources.service';
import { AssetManagementService } from './asset-management.service';

@Controller('api/asset-management')
export class AssetManagementController {
    constructor(
        private readonly source: AssetSourcesService,
        private readonly management: AssetManagementService,
    ) {}
    @Post('impact') async impact(@Req() req: Request, @Body() body: unknown) {
        return this.management.impact(await this.source.actor(req), body);
    }
    @Post('archive') async archive(@Req() req: Request, @Body() body: unknown) {
        return this.management.archive(await this.source.actor(req), body);
    }
}
