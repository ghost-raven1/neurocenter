import { Body, Controller, Get, Param, Post, Req, Header, HttpCode } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { OpenCodePersonalKeyService } from './service';
/** Secret POST bodies are accepted only over the authenticated device channel. */
@Controller()
export class OpenCodePersonalKeyController {
    constructor(private readonly service: OpenCodePersonalKeyService) {}
    private bearer(req: Request) {
        assertInternal(req.headers['x-neurocenter-internal']);
        return String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    }
    @Post('internal/device-channel/opencode-personal-key/context') @HttpCode(200) context(
        @Req() req: Request,
        @Body() body: unknown,
    ) {
        return this.service.context(this.bearer(req), body);
    }
    @Post('internal/device-channel/opencode-personal-key/save') @HttpCode(200) save(
        @Req() req: Request,
        @Body() body: unknown,
    ) {
        return this.service.save(this.bearer(req), body);
    }
    @Post('internal/device-channel/opencode-personal-key/receipt') @HttpCode(200) receipt(
        @Req() req: Request,
        @Body() body: unknown,
    ) {
        return this.service.receipt(this.bearer(req), body);
    }
    @Get('api/models/:id/my-access/transfers/:jobId') @Header('Cache-Control', 'no-store') browser(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('jobId') jobId: string,
    ) {
        return this.service.browserReceipt(req, id, jobId);
    }
}
