import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ChatSystemRolesService } from './chat-system-roles.service';
/** Reads/replays resolve only the caller's immutable private binding, including with new work disabled. */
@Controller('api/chat-system-roles')
export class ChatSystemRolesController {
    constructor(private readonly origins: ChatSystemRolesService) {}
    @Get('origin') read(@Req() req: Request, @Query() query: unknown) {
        return this.origins.read(req, query);
    }
    @Post('origin') bind(@Req() req: Request, @Body() body: unknown) {
        return this.origins.bind(req, body);
    }
}
