import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AGENT_METHOD_VERSIONS } from '../../../shared/agent-method-workflow.cjs';
import {
    BACKGROUND_AGENT_OPENCODE_VERSION,
    BACKGROUND_AGENT_PROTOCOL,
    BACKGROUND_AGENT_RUNTIME,
    BACKGROUND_AGENT_WORKFLOW_JOB,
    normalizeBackgroundAgentPayload,
    type IBackgroundAgentCheck,
    type IBackgroundAgentContext,
    type IBackgroundAgentPayload,
    type TBackgroundAgentMethod,
} from '../../../shared/background-agent.cjs';

export { BACKGROUND_AGENT_WORKFLOW_JOB, BACKGROUND_AGENT_OPENCODE_VERSION };

/**
 * FR-305 (agt-07, phase B): the server background-agent job machine. The job is executed by the
 * catalog-service background-agent worker (autonomous-package engine, OQ-2), not by a device: the
 * admission pins the immutable task (server-fixed method version and deadline, declared checks) and
 * the claim/complete authorization mirrors the agent-method-workflow jobs pattern, minus the device
 * binding — the project grant of the admitting user is the execution authority.
 */

/**
 * What a project-scoped start endpoint accepts. Everything else — ids, method version, deadline and
 * the pinned runtime version — is fixed by the server, never by the client.
 */
export interface IBackgroundAgentJobInput {
    requestKey: string;
    projectId: string;
    method: TBackgroundAgentMethod;
    instruction: string;
    checks: IBackgroundAgentCheck[];
    context?: IBackgroundAgentContext;
}

/** The server job row as the store returns it (pg store, phase B block 3). */
export interface IBackgroundAgentJobRow {
    kind: string;
    payload: unknown;
    project_id: string | null;
    email: string;
    role: string;
}

const ALLOWED_INPUT_KEYS = ['requestKey', 'projectId', 'method', 'instruction', 'checks', 'context'];
const BACKGROUND_AGENT_DEADLINE_MINUTES = 30;

/**
 * Admission: normalize the immutable task (shared contract: method version pinned to
 * AGENT_METHOD_VERSIONS, deadline fixed by the server, workflowId=requestId=requestKey). The OpenCode
 * runtime version (OQ-2) is not a payload field — the job row records it in the runtime_version column
 * (block 3) and the worker validates the autonomous package against it before the run.
 */
export function backgroundAgentJobPayload(input: IBackgroundAgentJobInput): IBackgroundAgentPayload {
    if (Object.keys(input).some((key) => !ALLOWED_INPUT_KEYS.includes(key)) || !input.projectId || !input.requestKey)
        throw new BadRequestException('Передайте проект и задачу фонового агента.');
    if (!Object.prototype.hasOwnProperty.call(AGENT_METHOD_VERSIONS, input.method))
        throw new BadRequestException('Выберите методику задачи.');
    try {
        return normalizeBackgroundAgentPayload({
            protocol: BACKGROUND_AGENT_PROTOCOL,
            workflowId: input.requestKey,
            requestId: input.requestKey,
            projectId: input.projectId,
            method: input.method,
            methodVersion: AGENT_METHOD_VERSIONS[input.method],
            instruction: input.instruction,
            checks: input.checks,
            ...(input.context ? { context: input.context } : {}),
            deadlineAt: new Date(Date.now() + BACKGROUND_AGENT_DEADLINE_MINUTES * 60 * 1000).toISOString(),
            runtime: BACKGROUND_AGENT_RUNTIME,
        });
    } catch {
        throw new BadRequestException('Задача или команды проверки имеют неподдерживаемый формат.');
    }
}

/**
 * Recheck the immutable payload against the owning project before claim and every authorization
 * poll. A stored row that no longer normalizes (tampered or corrupt) is not claimable: fail-closed.
 */
export function assertBackgroundAgentJob(job: IBackgroundAgentJobRow): IBackgroundAgentPayload | undefined {
    if (job.kind !== BACKGROUND_AGENT_WORKFLOW_JOB) return;
    let payload: IBackgroundAgentPayload;
    try {
        payload = normalizeBackgroundAgentPayload(job.payload);
    } catch {
        throw new ConflictException('Задание фонового агента повреждено или изменено.');
    }
    if (payload.projectId !== (job.project_id ?? ''))
        throw new ConflictException('Задание относится к другому проекту.');
    return payload;
}

/** A late completion cannot outlive the owner's account or the project grant (agent-method pattern). */
export async function assertBackgroundAgentCompletionAccess(
    db: PoolClient,
    job: Pick<IBackgroundAgentJobRow, 'project_id' | 'email' | 'role'>,
): Promise<void> {
    const user = (
        await db.query<{ enabled: boolean; is_main_admin: boolean }>(
            'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',
            [job.email],
        )
    ).rows[0];
    const grant = (
        await db.query<{ role: string }>(
            'SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',
            [job.project_id, job.email],
        )
    ).rows[0];
    const allowed = (role: string) =>
        role === 'Главный админ' ? user?.is_main_admin : role === 'Админ проекта' && grant?.role === 'Админ проекта';
    if (!user?.enabled || !allowed(job.role)) throw new ForbiddenException('Доступ к результату задачи отозван.');
}
