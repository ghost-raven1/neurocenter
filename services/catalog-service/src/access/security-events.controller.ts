import { Body, Controller, Headers, Post } from '@nestjs/common';
import type { ISecurityEvent } from './security-events';
import { assertInternal } from './access.controller';
import { SecurityEventsService } from './security-events.service';

/**
 * P0-RES/AD-O7: приём security-событий от писателей без прямого PG
 * (oauth2-bridge, api-gateway). Доставка из file outbox писателя;
 * идемпотентность по event_id внутри security_events.
 */
@Controller()
export class SecurityEventsController {
    constructor(private readonly events: SecurityEventsService) {}
    /** Тело — конверт `{ events }`, как у соседнего /internal/skill-audit/events. */
    @Post('internal/security-events')
    async record(@Headers('x-neurocenter-internal') token: string, @Body() body: { events?: ISecurityEvent[] }) {
        assertInternal(token);
        return this.events.record(body?.events ?? []);
    }
}
