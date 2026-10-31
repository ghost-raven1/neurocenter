import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { chatUuid } from '../model-chat/chat-validation';
import { AgentToolsService } from './agent-tools.service';
/** Read-only receipts survive feature OFF; caller and original chat permissions are checked on every read. */
@Controller('api/agent-tools')
export class AgentToolsController {
    constructor(private readonly tools: AgentToolsService) {}
    @Get('capabilities') capabilities(@Req() req: Request, @Query('projectId') projectId: string) {
        return this.tools.capabilities(req, projectId);
    }
    @Get('steps') list(@Req() req: Request, @Query('projectId') projectId: string, @Query('turnId') turnId: string) {
        return this.tools.history(req, projectId, chatUuid(turnId));
    }
    @Get('steps/:id') get(@Req() req: Request, @Param('id') id: string) {
        return this.tools.detail(req, chatUuid(id));
    }
}
