import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { FeatureAccess, assertFeatureInternal } from '../access/feature-access';
import { FlagsService } from './flags.service';

/** Чтение вычисленного состояния доступно участникам; изменение платформы требует главного администратора. */
@Controller()
export class FlagsController {
    constructor(
        private readonly flags: FlagsService,
        private readonly access: FeatureAccess,
    ) {}

    @Get('api/feature-flags')
    async list(@Req() req: Request) {
        await this.access.requireMain(req);
        return this.flags.list();
    }

    @Get('api/feature-flags/evaluated')
    async evaluated(@Req() req: Request) {
        await this.access.actor(req);
        return this.flags.evaluated();
    }

    @Patch('api/feature-flags/:key')
    async patch(@Param('key') key: string, @Body() body: unknown, @Req() req: Request) {
        await this.access.requireMain(req);
        return this.flags.patch(key, body, () => this.access.requireMain(req));
    }

    @Get('internal/feature-flags/evaluated')
    internal(@Req() req: Request) {
        assertFeatureInternal(req.headers['x-neurocenter-internal']);
        return this.flags.evaluated();
    }
}
