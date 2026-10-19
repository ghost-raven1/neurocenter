import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';

export interface ISecurityEvent {actor:string; action:string; resourceId:string; before:unknown; after:unknown}

/** Параллельные lifecycle/процессы готовят общий журнал последовательно в своей БД. */
export async function setupSecurityEvents(pool:Pool):Promise<void> {
    const client=await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:security-events-schema',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS security_events (
        event_id UUID PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
        resource_id TEXT NOT NULL, before_state JSONB, after_state JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    ); CREATE INDEX IF NOT EXISTS security_events_created ON security_events(created_at DESC)`);
        await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally {client.release();}
}

export async function securityEvent(client:PoolClient,event:ISecurityEvent):Promise<void> {
    await client.query('INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(),event.actor,event.action,event.resourceId,JSON.stringify(event.before),JSON.stringify(event.after)]);
}
