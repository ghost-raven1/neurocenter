import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface ISecurityEvent {
    actor: string;
    action: string;
    resourceId: string;
    before: unknown;
    after: unknown;
    /**
     * Стабильный id события (P0-RES): писатели без прямого PG (oauth2-bridge, api-gateway)
     * доставляют события через outbox; повторная доставка не дублирует запись (AD-O7, Q4).
     */
    eventId?: string;
}

export async function securityEvent(client: Pick<PoolClient, 'query'>, event: ISecurityEvent): Promise<void> {
    const id =
        event.eventId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.eventId)
            ? event.eventId.toLowerCase()
            : randomUUID();
    await client.query(
        'INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO NOTHING',
        [
            id,
            event.actor,
            event.action,
            event.resourceId,
            JSON.stringify(event.before ?? null),
            JSON.stringify(event.after ?? null),
        ],
    );
}
