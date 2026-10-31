import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { DeviceStore } from '../devices/device-store';
import { LearningQuirksService } from './learning-quirks.service';

/** Source bytes are accepted only by the private authenticated device channel. */
@Controller('internal/device-channel/learning-quirks')
export class LearningQuirksController {
    constructor(
        private readonly devices: DeviceStore,
        private readonly quirks: LearningQuirksService,
    ) {}
    @Post('import') async import(@Req() req: Request, @Body() value: unknown) {
        assertInternal(req.headers['x-neurocenter-internal']);
        const device = await this.devices.identity(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
        return this.quirks.import(device, value);
    }
}
