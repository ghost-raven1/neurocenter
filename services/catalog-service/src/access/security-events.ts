import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface ISecurityEvent {
    actor: string;
    action: string;
    resourceId: string;
    before: unknown;
    after: unknown;
}

export async function securityEvent(client: PoolClient, event: ISecurityEvent): Promise<void> {
    await client.query(
        'INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',
        [
            randomUUID(),
            event.actor,
            event.action,
            event.resourceId,
            JSON.stringify(event.before),
            JSON.stringify(event.after),
        ],
    );
}
