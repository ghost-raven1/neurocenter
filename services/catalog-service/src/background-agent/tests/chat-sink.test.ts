import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { IRuntimeResult } from '../runtime';
import { BackgroundAgentChatSink } from '../chat-sink';
import type { PgBackgroundAgentStore } from '../pg-store';
import { AGENT_RESULT_VERIFICATION_PROTOCOL } from '../../../../shared/agent-result-verification.cjs';

const PROJECT = 'prj-sink';
const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SOURCE = '11111111-2222-4333-8444-555555555555';
const REQUEST = '99999999-8888-4777-8666-555555555555';
const EMAIL = 'owner@example.com';
const ROLE = 'Админ проекта';

const receipt: IRuntimeResult = {
    protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
    state: 'succeeded',
    stage: 'completed',
    checks: [{ command: 'npm', args: ['test'], exitCode: 0, signal: null, state: 'passed' }],
};

interface IScenario {
    /** The source message's room; null = the source row is gone. */
    sourceRoom?: string | null;
    /** platform_users (authorize + completion access). */
    user?: { enabled: boolean; is_main_admin: boolean } | null;
    /** The project grant of the owner. */
    grant?: string | null;
    projectState?: string | null;
    room?: { visibility: 'PUBLIC' | 'PRIVATE'; creator_email: string | null } | null;
    roomMember?: boolean;
    sourceKind?: string | null;
    /** Slot (source_message_id, agentId) already taken by an earlier publication. */
    slotTaken?: boolean;
    /** A transient failure of the publication itself (must propagate, never withhold). */
    publishError?: Error;
}

interface IQ {
    sql: string;
    values?: unknown[];
}

/** Fake PG client: routes the sink's fixed query set by distinctive SQL fragments. */
class FakeClient {
    calls: IQ[] = [];
    constructor(private readonly scenario: IScenario) {}
    async release(): Promise<void> {}
    async query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
        this.calls.push({ sql, values });
        const empty = { rows: [] as unknown[], rowCount: 0 };
        if (/^BEGIN/.test(sql) || /^COMMIT/.test(sql) || /^ROLLBACK/.test(sql)) return empty;
        if (sql.includes('SELECT room_id FROM project_chat_messages'))
            return {
                rows:
                    this.scenario.sourceRoom === null || this.scenario.sourceRoom === undefined
                        ? []
                        : [{ room_id: this.scenario.sourceRoom }],
                rowCount: 1,
            };
        if (sql.includes('FROM platform_users') && sql.includes('display_name'))
            return {
                rows: this.scenario.user ? [{ ...this.scenario.user, display_name: 'Владелец' }] : [],
                rowCount: 1,
            };
        if (sql.includes('FROM platform_users'))
            return { rows: this.scenario.user ? [this.scenario.user] : [], rowCount: 1 };
        if (sql.includes('FROM project_members WHERE lower(principal_name)=$1'))
            return {
                rows: this.scenario.grant ? [{ project_id: PROJECT, role: this.scenario.grant }] : [],
                rowCount: 1,
            };
        if (sql.includes('FROM project_members WHERE project_id=$1'))
            return { rows: this.scenario.grant ? [{ role: this.scenario.grant }] : [], rowCount: 1 };
        if (sql.includes('FROM projects WHERE id=$1'))
            return { rows: this.scenario.projectState ? [{ state: this.scenario.projectState }] : [], rowCount: 1 };
        if (sql.includes('FROM project_chat_rooms')) {
            const room = this.scenario.room ?? { visibility: 'PUBLIC' as const, creator_email: null };
            return {
                rows: [{ id: ROOM, project_id: PROJECT, revision: 1, ...room, updated_at: null }],
                rowCount: 1,
            };
        }
        if (sql.includes('FROM project_chat_room_members'))
            return {
                rows: this.scenario.roomMember ? [{ email: EMAIL }] : [],
                rowCount: this.scenario.roomMember ? 1 : 0,
            };
        if (sql.includes('SELECT kind FROM project_chat_messages'))
            return {
                rows: this.scenario.sourceKind ? [{ kind: this.scenario.sourceKind }] : [],
                rowCount: this.scenario.sourceKind ? 1 : 0,
            };
        if (sql.includes('INSERT INTO project_chat_messages')) {
            if (this.scenario.publishError) throw this.scenario.publishError;
            if (this.scenario.slotTaken) {
                const error = new Error('duplicate key');
                (error as { code?: string }).code = '23505';
                throw error;
            }
            return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE project_chat_rooms SET revision=revision+1')) return { rows: [], rowCount: 1 };
        throw new Error(`FakeClient: unexpected SQL: ${sql.slice(0, 80)}`);
    }
}

const baseScenario: Required<Omit<IScenario, 'publishError'>> = {
    sourceRoom: ROOM,
    user: { enabled: true, is_main_admin: false },
    grant: ROLE,
    projectState: 'ACTIVE',
    room: { visibility: 'PUBLIC', creator_email: null },
    roomMember: false,
    sourceKind: 'user',
    slotTaken: false,
};

function makeSink(scenario: IScenario, sourceMessageId: string | null = SOURCE) {
    const client = new FakeClient(scenario);
    const pool = {
        connect: async () => client,
        end: async () => undefined,
    };
    const withheld: string[] = [];
    const store = {
        findRow: async () => ({
            request_key: 'ab'.repeat(32),
            request_id: REQUEST,
            kind: 'run-background-agent-workflow',
            project_id: PROJECT,
            email: EMAIL,
            role: ROLE,
            payload: {},
            source_message_id: sourceMessageId,
            runtime_version: '1.14.48',
            state: 'succeeded',
            result: receipt,
            attempts: 0,
            next_attempt_at: null,
            unknown: false,
            dead_letter_reason: null,
            lease_token: null,
            lease_until: null,
            delivered: false,
            publish_state: 'pending',
        }),
        markWithheld: async (requestKey: string) => {
            withheld.push(requestKey);
        },
    } as unknown as PgBackgroundAgentStore;
    const sink = new BackgroundAgentChatSink(pool as unknown as Pool, store);
    return { sink, client, withheld };
}

describe('BackgroundAgentChatSink (I/O row 2: result into the project chat)', () => {
    it('publishes the verified receipt as a done agent message and bumps the room revision', async () => {
        const { sink, client } = makeSink(baseScenario);
        await sink.deliver(REQUEST, receipt);
        const insert = client.calls.find((call) => call.sql.includes('INSERT INTO project_chat_messages'));
        expect(insert).toBeTruthy();
        const values = insert!.values as unknown[];
        expect(values[1]).toBe(PROJECT);
        expect(values[2]).toBe(ROOM);
        expect(values[3]).toBe(SOURCE); // $4 = reply_to_id = source_message_id
        const snapshot = JSON.parse(String(values[4])) as Record<string, unknown>;
        expect(snapshot.agentId).toBe('background-agent');
        expect(String(values[5])).toContain('Фоновая задача завершена');
        const bump = client.calls.find((call) =>
            call.sql.includes('UPDATE project_chat_rooms SET revision=revision+1'),
        );
        expect(bump).toBeTruthy();
        expect(client.calls.some((call) => call.sql.startsWith('COMMIT'))).toBe(true);
        expect(client.calls.some((call) => call.sql.startsWith('ROLLBACK'))).toBe(false);
    });

    it('renders a failed receipt with the failure code', async () => {
        const failed: IRuntimeResult = {
            ...receipt,
            state: 'failed',
            stage: 'checks',
            checks: [{ command: 'npm', args: ['test'], exitCode: 1, signal: null, state: 'failed' }],
            failure: { code: 'CHECK_FAILED', action: 'review-result' },
        };
        const { sink, client } = makeSink(baseScenario);
        await sink.deliver(REQUEST, failed);
        const insert = client.calls.find((call) => call.sql.includes('INSERT INTO project_chat_messages'));
        expect(String((insert!.values as unknown[])[5])).toContain('CHECK_FAILED');
    });

    it('withholds when the owner account was disabled (never discards, never throws)', async () => {
        const { sink, client, withheld } = makeSink({
            ...baseScenario,
            user: { enabled: false, is_main_admin: false },
        });
        await sink.deliver(REQUEST, receipt);
        expect(withheld).toHaveLength(1);
        expect(client.calls.some((call) => call.sql.includes('INSERT INTO project_chat_messages'))).toBe(false);
        expect(client.calls.some((call) => call.sql.startsWith('ROLLBACK'))).toBe(true);
    });

    it('withholds when the project grant was revoked', async () => {
        const { sink, client, withheld } = makeSink({ ...baseScenario, grant: null });
        await sink.deliver(REQUEST, receipt);
        expect(withheld).toHaveLength(1);
        expect(client.calls.some((call) => call.sql.includes('INSERT INTO project_chat_messages'))).toBe(false);
    });

    it('withholds when the source message is gone or no longer a user message', async () => {
        for (const scenario of [
            { ...baseScenario, sourceRoom: null },
            { ...baseScenario, sourceKind: 'agent' },
        ] as IScenario[]) {
            const { sink, client, withheld } = makeSink(scenario);
            await sink.deliver(REQUEST, receipt);
            expect(withheld, scenario.sourceKind === 'agent' ? 'agent source' : 'missing source').toHaveLength(1);
            expect(client.calls.some((call) => call.sql.includes('INSERT INTO project_chat_messages'))).toBe(false);
        }
    });

    it('withholds a private dialogue the owner cannot see', async () => {
        const { sink, withheld } = makeSink({
            ...baseScenario,
            room: { visibility: 'PRIVATE', creator_email: 'other@example.com' },
            roomMember: false,
        });
        await sink.deliver(REQUEST, receipt);
        expect(withheld).toHaveLength(1);
    });

    it('withholds when the (source_message_id, agentId) slot is already published', async () => {
        const { sink, client, withheld } = makeSink({ ...baseScenario, slotTaken: true });
        await sink.deliver(REQUEST, receipt);
        expect(withheld).toHaveLength(1);
        expect(client.calls.some((call) => call.sql.startsWith('ROLLBACK'))).toBe(true);
    });

    it('withholds a job row without a durable chat origin', async () => {
        const { sink, client, withheld } = makeSink(baseScenario, null);
        await sink.deliver(REQUEST, receipt);
        expect(withheld).toHaveLength(1);
        expect(client.calls).toHaveLength(0);
    });

    it('propagates a transient publication failure (the supervisor re-delivers; never withholds)', async () => {
        const { sink, client, withheld } = makeSink({ ...baseScenario, publishError: new Error('connection lost') });
        await expect(sink.deliver(REQUEST, receipt)).rejects.toThrow('connection lost');
        expect(withheld).toHaveLength(0);
        expect(client.calls.some((call) => call.sql.startsWith('ROLLBACK'))).toBe(true);
    });
});
