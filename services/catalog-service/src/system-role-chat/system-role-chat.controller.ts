import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SystemRoleChatService } from './system-role-chat.service';

/** History/recovery/cancel remain readable with execution disabled; the owner checks fresh ACL. */
@Controller('api/system-role-chats')
export class SystemRoleChatController {
    constructor(private readonly chats: SystemRoleChatService) {}
    @Get() list(@Req() req: Request, @Query('projectId') project?: string, @Query('agentId') agent?: string) { return this.chats.list(req, project, agent); }
    @Post() create(@Req() req: Request, @Body() body: unknown) { return this.chats.create(req, body); }
    @Get(':dialogId') detail(@Req() req: Request, @Param('dialogId') dialog: string, @Query('agentId') agent?: string) { return this.chats.detail(req, dialog, agent); }
    @Post(':dialogId/prepare') prepare(@Req() req: Request, @Param('dialogId') dialog: string, @Body() body: unknown) { return this.chats.prepare(req, dialog, body); }
    @Post(':dialogId/turns') send(@Req() req: Request, @Param('dialogId') dialog: string, @Body() body: unknown) { return this.chats.send(req, dialog, body); }
    @Get(':dialogId/requests/:requestId') request(@Req() req: Request, @Param('dialogId') dialog: string, @Param('requestId') request: string) { return this.chats.request(req, dialog, request); }
    @Post(':dialogId/turns/:turnId/cancel') cancel(@Req() req: Request, @Param('dialogId') dialog: string, @Param('turnId') turn: string, @Body() body: unknown) { return this.chats.cancel(req, dialog, turn, body); }
}
