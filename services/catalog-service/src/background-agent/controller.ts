import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BackgroundAgentService, type IBackgroundAgentStartReceipt } from './service';

/**
 * FR-305 (agt-07, phase B): the project-scoped start of the background agent from a published chat
 * message (I/O row 1). The endpoint admits only — authorization + the immutable task row with the
 * durable chat origin; the execution happens asynchronously in the `background-agent` compose
 * service, so the chat is never blocked. The receipt's requestKey is the idempotency/audit key of
 * the admitted run.
 */
@Controller('api/projects/:projectId/team-chat')
export class BackgroundAgentController {
    constructor(private readonly backgroundAgent: BackgroundAgentService) {}

    @Post('rooms/:roomId/messages/:messageId/background-agent')
    start(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Param('messageId') messageId: string,
        @Body() body: unknown,
    ): Promise<IBackgroundAgentStartReceipt> {
        return this.backgroundAgent.start(req, projectId, roomId, messageId, body);
    }
}
