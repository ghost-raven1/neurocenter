import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { DeviceStore } from '../devices/device-store';
import { OpenCodeModelSyncService } from './opencode-model-sync.service';

/** Browser reads consent and safe source metadata; secrets arrive exclusively over the authenticated device channel. */
@Controller()
export class OpenCodeModelSyncController {
    constructor(private readonly devices: DeviceStore, private readonly sync: OpenCodeModelSyncService) {}
    private device(req: Request) { assertInternal(req.headers['x-neurocenter-internal']); return this.devices.identity(String(req.headers.authorization ?? '').replace(/^Bearer /, '')); }
    @Get('api/devices/:id/opencode-model-sync') read(@Req() req: Request, @Param('id') id: string) { return this.sync.read(req, id); }
    @Put('api/devices/:id/opencode-model-sync') configure(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.sync.configure(req, id, body); }
    @Post('internal/device-channel/opencode-models/context') async context(@Req() req: Request) { return this.sync.context(await this.device(req)); }
    @Post('internal/device-channel/opencode-models/sync') async snapshot(@Req() req: Request, @Body() body: unknown) { return this.sync.sync(await this.device(req), body, () => this.device(req)); }
}
