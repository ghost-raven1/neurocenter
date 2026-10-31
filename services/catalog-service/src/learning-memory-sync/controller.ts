import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { DeviceStore } from '../devices/device-store';
import { DeviceJobs } from '../devices/device-jobs';

/** A device sees approved text only through its own current running job and lease. */
@Controller('internal/device-channel/learning-memory')
export class LearningMemorySyncController {
    constructor(
        private readonly devices: DeviceStore,
        private readonly jobs: DeviceJobs,
    ) {}
    @Post('context') async context(@Req() req: Request, @Body() input: unknown) {
        assertInternal(req.headers['x-neurocenter-internal']);
        const device = await this.devices.identity(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
        return this.jobs.memorySyncContext(device, input);
    }
}
