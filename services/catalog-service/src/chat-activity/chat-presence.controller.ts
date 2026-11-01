import { Body, Controller, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ChatPresenceService } from './chat-presence.service';
import type { IChatActivitySessionInput } from './chat-activity.interfaces';

/** Gateway identity is rechecked against the current account and active role for every heartbeat. */
@Controller('api/chat-presence')
export class ChatPresenceController {
    constructor(private readonly presence: ChatPresenceService) {}
    @Put('session') update(@Req() req: Request, @Body() body: IChatActivitySessionInput): Promise<{ ok: true }> {
        return this.presence.update(req, body);
    }
}
