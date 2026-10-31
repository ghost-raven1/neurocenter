import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';

import { normalizeSkillAuditEvents } from '../../../shared/skill-audit.cjs';

/** Квитанция и событие сохраняются одной транзакцией; потерянное подтверждение можно безопасно повторить. */
export class SkillAuditRepository {
    constructor(private readonly pool: Pool) {}

    public async record(raw: unknown): Promise<{ accepted: number }> {
        let events;
        try {
            events = normalizeSkillAuditEvents(raw);
        } catch (error) {
            throw new BadRequestException(
                error instanceof Error ? error.message : 'Некорректное событие аудита скилла.',
            );
        }
        if (!events.length) {
            return { accepted: 0 };
        }
        const unique = [...new Map(events.map((event) => [event.id, event])).values()].sort((a, b) =>
            a.id.localeCompare(b.id),
        );
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            for (const event of unique) {
                const payload = JSON.stringify(event);
                const receipt = await client.query(
                    'INSERT INTO skill_audit_receipts(event_id,payload) VALUES($1,$2::jsonb) ON CONFLICT(event_id) DO NOTHING RETURNING event_id',
                    [event.id, payload],
                );
                if (!receipt.rows.length) {
                    const previous = await client.query(
                        'SELECT event_id FROM skill_audit_receipts WHERE event_id=$1 AND payload=$2::jsonb',
                        [event.id, payload],
                    );
                    if (!previous.rows.length) {
                        throw new ConflictException('UUID аудита скилла уже принят с другими данными.');
                    }
                    continue;
                }
                const state = (value: typeof event.before | typeof event.after) =>
                    value === null ? null : { ...value, source: event.source };
                await client.query(
                    'INSERT INTO security_events(event_id,created_at,actor,action,resource_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
                    [
                        event.id,
                        event.at,
                        event.actor,
                        event.action,
                        event.resourceId,
                        JSON.stringify(state(event.before)),
                        JSON.stringify(state(event.after)),
                    ],
                );
            }
            await client.query('COMMIT');
            return { accepted: events.length };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}
