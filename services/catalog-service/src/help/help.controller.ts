import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { HelpService } from './help.service';

@Controller('api/help')
export class HelpController {
    constructor(private readonly help: HelpService) {}
    @Get() list(@Req() req: Request) {
        return this.help.list(req);
    }
    @Get(':slug') read(@Req() req: Request, @Param('slug') slug: string) {
        return this.help.read(req, slug);
    }
    @Put(':slug') save(@Req() req: Request, @Param('slug') slug: string, @Body() body: unknown) {
        return this.help.save(req, slug, body);
    }
}
