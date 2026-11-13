import { describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SystemRoleAgentCall } from '../system-role.agent-call';
import { roleDefinitionPin, systemRole } from '../system-role.definitions';
import type { IChatAgentSnapshot } from '../../model-chat/chat-group.interfaces';
import type { IRoleRunRow } from '../system-role.interfaces';
import type { ModelsService } from '../../models/models.service';
import type { ProjectChatService } from '../../project-chat/project-chat.service';
import type { SystemRoleService } from '../system-role.service';

const ROLE = 'agent-coordinator';
const SHA = 'a'.repeat(64);
const DIGEST = 'd'.repeat(64);
const PIN = roleDefinitionPin(ROLE);
const CALLER_ID = 'agent-11111111-1111-4111-8111-111111111111';

const callerSnapshot: IChatAgentSnapshot = {
    agentId: CALLER_ID,
    name: 'Dev Agent',
    slug: 'dev-agent',
    version: 3,
    manifest: 'b'.repeat(64),
    definition: { description: 'Разработка', prompt: '', mode: 'all', permission: {} },
    modelId: 'model-1',
    modelName: 'GPT',
    modelPin: SHA,
    sha256: 'c'.repeat(64),
};

const req = {} as never;
const roleDefinition = systemRole(ROLE);

interface Recorded {
    sql: string;
    params: unknown[];
}

function fakePool(overrides: { callRows?: unknown[]; runRows?: unknown[]; reapRows?: unknown[] } = {}) {
    const recorded: Recorded[] = [];
    const client = {
        query: async (sql: string, params: unknown[] = []) => {
            recorded.push({ sql, params });
            if (/SELECT \* FROM project_chat_system_calls WHERE run_id/.test(sql))
                return { rows: overrides.callRows ?? [] };
            if (/SELECT \* FROM system_role_runs WHERE id/.test(sql)) return { rows: overrides.runRows ?? [] };
            if (/SELECT \* FROM project_chat_rooms WHERE project_id/.test(sql))
                return { rows: [{ project_id: 'p1', id: 'room-1', revision: 5, agent_ids: [CALLER_ID] }] };
            if (/SELECT run_id FROM project_chat_system_calls WHERE state/.test(sql))
                return { rows: overrides.reapRows ?? [{ run_id: 'run-1' }] };
            return { rows: [] };
        },
        release: () => {},
    };
    const pool = { connect: async () => client };
    return { pool, recorded };
}

function makeCall(systemRoles: Record<string, unknown>, pool: { connect: unknown }) {
    const chats = {
        attachSystemCalls: () => {},
        repository: {
            room: async (_db: never, projectId: string, _write: boolean, roomId: string) =>
                ({ project_id: projectId, id: roomId, revision: 5, agent_ids: [] }) as never,
            bump: async () => {},
        },
    } as unknown as ProjectChatService;
    const models = { pool } as unknown as ModelsService;
    return new SystemRoleAgentCall(models, systemRoles as SystemRoleService, chats);
}

function runRow(partial: Partial<IRoleRunRow>): IRoleRunRow {
    return {
        id: 'run-1',
        agent_id: ROLE,
        project_id: 'p1',
        actor: 'a@example.test',
        actor_role: 'Разработчик',
        request_id: 'req-1',
        request_hash: SHA,
        request: {} as never,
        snapshot: {} as never,
        model: {} as never,
        state: 'succeeded',
        phase: 'done',
        revision: 1,
        lease_token: 'lease',
        lease_until: null,
        calls_started: 1,
        facts: [],
        result: null,
        steps: [],
        applied: [],
        message: '',
        created_at: new Date(),
        ...partial,
    } as IRoleRunRow;
}

const callRow = {
    project_id: 'p1',
    room_id: 'room-1',
    call_id: 'call-1',
    actor_email: 'a@example.test',
    actor_role: 'Разработчик',
    source_message_id: 'src-1',
    response_id: 'resp-1',
    response_generation: 'gen-1',
    agent_id: CALLER_ID,
    agent_name: 'Dev Agent',
    snapshot: { agentId: ROLE, name: 'Координатор' },
    role_id: ROLE,
    reason: 'problem',
    question: 'Вопрос агента',
    run_id: 'run-1',
    request_id: 'req-1',
    state: 'invoked',
    run_state: null,
    error: null,
};

describe('SystemRoleAgentCall.invoke', () => {
    it('runs the durable role pipeline with the caller model and no explicit targets (room read would deadlock)', async () => {
        const calls: Array<[string, unknown, unknown]> = [];
        const systemRoles = {
            attachAgentCall: () => {},
            prepare: async (_req: never, roleId: string, selection: unknown) => {
                calls.push(['prepare', roleId, selection]);
                return { consentDigest: DIGEST, definitionPin: PIN };
            },
            start: async (_req: never, roleId: string, input: unknown) => {
                calls.push(['start', roleId, input]);
                return { id: 'run-1' };
            },
        };
        const call = makeCall(systemRoles, fakePool().pool);
        const outcome = await call.invoke({
            req,
            projectId: 'p1',
            roomId: 'room-1',
            roomVisibility: 'PUBLIC',
            call: { roleId: ROLE, reason: 'problem', question: 'Вопрос агента' },
            snapshot: callerSnapshot,
        });
        expect(calls[0]).toEqual([
            'prepare',
            ROLE,
            {
                projectId: 'p1',
                instruction: 'Вопрос агента',
                diagnostics: [],
                targets: [],
            },
        ]);
        const startInput = calls[1][2] as Record<string, unknown>;
        expect(startInput.requestId).toMatch(/^[a-f0-9]{8}-/);
        expect(startInput.modelId).toBe('model-1');
        expect(startInput.expectedModelPin).toBe(SHA);
        expect(startInput.expectedDefinitionPin).toBe(PIN);
        expect(startInput.consentDigest).toBe(DIGEST);
        expect(outcome.runId).toBe('run-1');
        expect(outcome.requestId).toBe(startInput.requestId);
        expect(outcome.error).toBeUndefined();
        expect(outcome.snapshot).toEqual({
            agentId: ROLE,
            name: roleDefinition.name,
            slug: ROLE,
            version: 1,
            manifest: PIN,
            definition: {
                description: roleDefinition.description,
                prompt: 'Системная роль Нейроцентра.',
                mode: 'all',
                permission: {},
            },
            modelId: 'model-1',
            modelName: 'GPT',
            modelPin: SHA,
            sha256: PIN,
        });
    });

    it('selects no target in a private room', async () => {
        const calls: Array<[string, unknown, unknown]> = [];
        const systemRoles = {
            attachAgentCall: () => {},
            prepare: async (_req: never, roleId: string, selection: unknown) => {
                calls.push(['prepare', roleId, selection]);
                return { consentDigest: DIGEST, definitionPin: PIN };
            },
            start: async () => ({ id: 'run-1' }),
        };
        const call = makeCall(systemRoles, fakePool().pool);
        await call.invoke({
            req,
            projectId: 'p1',
            roomId: 'room-1',
            roomVisibility: 'PRIVATE',
            call: { roleId: ROLE, reason: 'problem', question: 'q' },
            snapshot: callerSnapshot,
        });
        expect((calls[0][2] as { targets: unknown[] }).targets).toEqual([]);
    });

    it('returns an actionable rejection when the role is unknown (no pipeline call)', async () => {
        const systemRoles = {
            attachAgentCall: () => {},
            prepare: async () => {
                throw new Error('must not run');
            },
            start: async () => {
                throw new Error('must not run');
            },
        };
        const call = makeCall(systemRoles, fakePool().pool);
        const outcome = await call.invoke({
            req,
            projectId: 'p1',
            roomId: 'room-1',
            roomVisibility: 'PUBLIC',
            call: { roleId: 'agent-nobody', reason: 'problem', question: 'q' },
            snapshot: callerSnapshot,
        });
        expect(outcome.error).toBe(new NotFoundException('Системный агент не найден.').message);
        expect(outcome.snapshot).toEqual(callerSnapshot);
        expect(outcome.runId).toBeUndefined();
    });

    it('surfaces the pipeline conflict as an actionable rejection with the role snapshot', async () => {
        const systemRoles = {
            attachAgentCall: () => {},
            prepare: async () => {
                throw new ConflictException('Контекст изменился. Подготовьте и подтвердите его заново.');
            },
            start: async () => ({ id: 'run-1' }),
        };
        const call = makeCall(systemRoles, fakePool().pool);
        const outcome = await call.invoke({
            req,
            projectId: 'p1',
            roomId: 'room-1',
            roomVisibility: 'PUBLIC',
            call: { roleId: ROLE, reason: 'problem', question: 'q' },
            snapshot: callerSnapshot,
        });
        expect(outcome.error).toBe('Контекст изменился. Подготовьте и подтвердите его заново.');
        expect(outcome.snapshot.agentId).toBe(ROLE);
    });

    it('falls back to a generic actionable message for unexpected errors', async () => {
        const systemRoles = {
            attachAgentCall: () => {},
            prepare: async () => {
                throw new Error('internal boom');
            },
            start: async () => ({ id: 'run-1' }),
        };
        const call = makeCall(systemRoles, fakePool().pool);
        const outcome = await call.invoke({
            req,
            projectId: 'p1',
            roomId: 'room-1',
            roomVisibility: 'PUBLIC',
            call: { roleId: ROLE, reason: 'recovery', question: 'q' },
            snapshot: callerSnapshot,
        });
        expect(outcome.error).toBe(
            'Не удалось выполнить системный вызов. Устраните причину и повторите запрос системной роли.',
        );
    });

    it('keeps the pipeline message of an unavailable-service rejection', async () => {
        const systemRoles = {
            attachAgentCall: () => {},
            prepare: async () => {
                throw new ServiceUnavailableException('Модель недоступна. Проверьте модель и повторите.');
            },
            start: async () => ({ id: 'run-1' }),
        };
        const call = makeCall(systemRoles, fakePool().pool);
        const outcome = await call.invoke({
            req,
            projectId: 'p1',
            roomId: 'room-1',
            roomVisibility: 'PUBLIC',
            call: { roleId: ROLE, reason: 'problem', question: 'q' },
            snapshot: callerSnapshot,
        });
        expect(outcome.error).toBe('Модель недоступна. Проверьте модель и повторите.');
    });
});

describe('SystemRoleAgentCall.deliver', () => {
    const deliverWith = async (overrides: { callRows?: unknown[]; runRows?: unknown[] } = {}) => {
        const { pool, recorded } = fakePool(overrides);
        const call = makeCall(
            { attachAgentCall: () => {}, prepare: async () => ({}), start: async () => ({ id: 'run-1' }) },
            pool,
        );
        await call.deliver('run-1');
        return recorded;
    };

    it('commits immediately when no invoked call row references the run', async () => {
        const recorded = await deliverWith({ callRows: [] });
        expect(recorded.some((row) => /INSERT INTO project_chat_messages/.test(row.sql))).toBe(false);
        expect(recorded[recorded.length - 1].sql).toBe('COMMIT');
    });

    it('waits for a terminal run without delivering', async () => {
        const recorded = await deliverWith({ callRows: [callRow], runRows: [runRow({ state: 'running' })] });
        expect(recorded.some((row) => /INSERT INTO project_chat_messages/.test(row.sql))).toBe(false);
        expect(recorded[recorded.length - 1].sql).toBe('COMMIT');
    });

    it('delivers a succeeded outcome to the caller room and completes the call row once', async () => {
        const result = {
            summary: 'Сводка',
            answer: 'Ответ системы',
            nextSteps: ['Проверьте журнал'],
            findings: [],
            changes: [],
        };
        const recorded = await deliverWith({
            callRows: [callRow],
            runRows: [runRow({ state: 'succeeded', result: result as never, message: '' })],
        });
        const insert = recorded.find((row) => /INSERT INTO project_chat_messages/.test(row.sql));
        expect(insert).toBeTruthy();
        const params = insert!.params;
        expect(params[1]).toBe('p1');
        expect(params[3]).toBe('resp-1'); // reply_to_id = the carrying answer
        expect(params[4]).toBe('resp-1'); // source_message_id = the carrying answer
        const snapshot = JSON.parse(params[5] as string);
        expect(snapshot.agentId).toBe(ROLE);
        const content = params[6] as string;
        expect(content).toContain('## Ответ системной роли «Координатор»');
        expect(content).toContain('Сводка');
        expect(content).toContain('Ответ системы');
        expect(content).toContain('- Проверьте журнал');
        expect(params[7]).toBe('gen-1');
        const update = recorded.find((row) => /UPDATE project_chat_system_calls SET state/.test(row.sql));
        expect(update!.params[1]).toBe('delivered');
        expect(update!.params[2]).toBe('succeeded');
        expect(recorded.some((row) => /INSERT INTO security_events/.test(row.sql))).toBe(true);
        expect(recorded.some((row) => /pg_advisory_xact_lock/.test(row.sql))).toBe(true);
        expect(recorded[recorded.length - 1].sql).toBe('COMMIT');
    });

    it('delivers an actionable failure for a failed run', async () => {
        const recorded = await deliverWith({
            callRows: [callRow],
            runRows: [runRow({ state: 'failed', message: 'Модель не ответила. Проверьте подключение.' })],
        });
        const insert = recorded.find((row) => /INSERT INTO project_chat_messages/.test(row.sql));
        const content = insert!.params[6] as string;
        expect(content).toContain('## Вызов системной роли «Координатор» не завершён');
        expect(content).toContain('Модель не ответила. Проверьте подключение.');
        const update = recorded.find((row) => /UPDATE project_chat_system_calls SET state/.test(row.sql));
        expect(update!.params[1]).toBe('failed');
        expect(update!.params[2]).toBe('failed');
    });

    it('marks an awaiting_review outcome as delivered with a human-confirmation notice', async () => {
        const result = { summary: 's', answer: 'a', nextSteps: [], findings: [], changes: [] };
        const recorded = await deliverWith({
            callRows: [callRow],
            runRows: [runRow({ state: 'awaiting_review', result: result as never, message: '' })],
        });
        const insert = recorded.find((row) => /INSERT INTO project_chat_messages/.test(row.sql));
        expect(insert!.params[6]).toContain('Результат требует подтверждения человека (запуск run-1).');
        const update = recorded.find((row) => /UPDATE project_chat_system_calls SET state/.test(row.sql));
        expect(update!.params[1]).toBe('delivered');
        expect(update!.params[2]).toBe('awaiting_review');
    });
});

describe('SystemRoleAgentCall.reap', () => {
    it('visits every invoked run id in order', async () => {
        const { pool } = fakePool({ reapRows: [{ run_id: 'run-1' }, { run_id: 'run-2' }] });
        const call = makeCall(
            { attachAgentCall: () => {}, prepare: async () => ({}), start: async () => ({ id: 'run-1' }) },
            pool,
        );
        const visited: string[] = [];
        (call as unknown as { deliver: (id: string) => Promise<void> }).deliver = async (id) => {
            visited.push(id);
        };
        await call.reap();
        expect(visited).toEqual(['run-1', 'run-2']);
    });
});
