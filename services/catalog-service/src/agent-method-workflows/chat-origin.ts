import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
    AGENT_METHOD_WORKFLOW_JOB,
    normalizeAgentMethodWorkflowResult,
} from '../../../shared/agent-method-workflow.cjs';
import type { IAccessActor } from '../access/access.model';
import type { Job, JobInput } from '../devices/device-job.model';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { ProjectChatPolicy } from '../project-chat/project-chat.policy';
import { assertProjectChatRoomAccess } from '../project-chat/project-chat-room-access';
import { projectChatUuid } from '../project-chat/project-chat.validation';
import type { ProjectChatDb, ProjectChatMessageRow, ProjectChatRoomRow } from '../project-chat/project-chat.types';
import type { MethodChatOrigin, MethodChatPublication } from './chat-workflows.types';

interface Link {
    job_id: string;
    project_id: string;
    room_id: string;
    source_message_id: string;
    owner_email: string;
    owner_role: string;
    publication_state: MethodChatPublication;
}
type LinkedJob = Pick<Job, 'id' | 'kind'> & { payload?: unknown };
const policy = new ProjectChatPolicy();

/** Origin is server metadata. It never enters the bridge protocol or changes a legacy job. */
export function methodChatOrigin(input: JobInput): MethodChatOrigin | undefined {
    if (
        input.kind !== AGENT_METHOD_WORKFLOW_JOB ||
        !Object.prototype.hasOwnProperty.call(input.workflow ?? {}, 'origin')
    )
        return;
    const raw = input.workflow?.origin;
    if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).some((key) => !['roomId', 'messageId'].includes(key)) ||
        typeof input.workflow?.agentId !== 'string' ||
        !input.workflow.agentId ||
        !Number.isSafeInteger(input.workflow.expectedAgentsRevision) ||
        Number(input.workflow.expectedAgentsRevision) < 1
    )
        throw new BadRequestException('Для задачи из чата выберите проектного агента и исходное сообщение.');
    // Shared receipts must not copy arbitrary private argv or absolute paths into a room.
    const presets = [['test'], ['run', 'typecheck'], ['run', 'check']];
    if (
        !Array.isArray(input.workflow.checks) ||
        input.workflow.checks.some(
            (check) =>
                !check ||
                typeof check !== 'object' ||
                Array.isArray(check) ||
                check.command !== 'npm' ||
                !presets.some((args) => JSON.stringify(args) === JSON.stringify(check.args)),
        )
    )
        throw new BadRequestException('Для задачи из чата выберите npm test, npm run typecheck или npm run check.');
    return { roomId: projectChatUuid(raw.roomId), messageId: projectChatUuid(raw.messageId) };
}

/** Caller owns the transaction: membership, source and private-room audience stay locked until commit. */
export async function assertMethodChatOrigin(
    db: ProjectChatDb,
    projectId: string,
    actor: IAccessActor,
    origin: MethodChatOrigin,
    recovery = false,
    write = false,
): Promise<void> {
    await policy.authorize(db, projectId, actor, 2, true, recovery);
    const room = (
        await db.query<ProjectChatRoomRow>(
            'SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2 ' + (write ? 'FOR UPDATE' : 'FOR SHARE'),
            [projectId, origin.roomId],
        )
    ).rows[0];
    if (!room) throw new NotFoundException('Исходный диалог не найден.');
    await assertProjectChatRoomAccess(db, room, actor.email);
    const source = (
        await db.query<Pick<ProjectChatMessageRow, 'kind'>>(
            'SELECT kind FROM project_chat_messages WHERE project_id=$1 AND room_id=$2 AND id=$3 FOR SHARE',
            [projectId, origin.roomId, origin.messageId],
        )
    ).rows[0];
    if (source?.kind !== 'user')
        throw new NotFoundException('Выберите опубликованное сообщение пользователя в этом диалоге.');
}

/** New linked jobs and their durable origin commit together; receipt replay never calls this again. */
export async function saveMethodChatOrigin(
    db: ProjectChatDb,
    jobId: string,
    projectId: string,
    actor: IAccessActor,
    origin: MethodChatOrigin,
): Promise<void> {
    await requireFeaturesEnabled(['project_agent_chat_workflows']);
    await assertMethodChatOrigin(db, projectId, actor, origin, false, true);
    await db.query(
        `INSERT INTO project_chat_method_workflows(job_id,project_id,room_id,source_message_id,owner_email,owner_role)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [jobId, projectId, origin.roomId, origin.messageId, actor.email, actor.activeRole],
    );
    await db.query('UPDATE project_chat_rooms SET revision=revision+1,updated_at=now() WHERE project_id=$1 AND id=$2', [
        projectId,
        origin.roomId,
    ]);
}

/** Poll fences keep optional origin authority independent from the immutable native-agent proof. */
export async function assertMethodChatJob(db: ProjectChatDb, job: Pick<LinkedJob, 'id' | 'kind'>): Promise<void> {
    if (job.kind !== AGENT_METHOD_WORKFLOW_JOB) return;
    const link = (
        await db.query<Link>('SELECT * FROM project_chat_method_workflows WHERE job_id=$1 FOR SHARE', [job.id])
    ).rows[0];
    if (!link) return;
    await requireFeaturesEnabled(['project_agent_chat_workflows']);
    await assertMethodChatOrigin(
        db,
        link.project_id,
        { email: link.owner_email, activeRole: link.owner_role },
        { roomId: link.room_id, messageId: link.source_message_id },
    );
}

/** Publication failure never discards observed work or asks a bridge to execute it again. */
export async function publishMethodChatResult(db: ProjectChatDb, job: LinkedJob, result?: unknown): Promise<void> {
    if (job.kind !== AGENT_METHOD_WORKFLOW_JOB) return;
    const link = (
        await db.query<Link>('SELECT * FROM project_chat_method_workflows WHERE job_id=$1 FOR UPDATE', [job.id])
    ).rows[0];
    if (!link || link.publication_state !== 'pending') return;
    let state: MethodChatPublication = 'published',
        publicResult: unknown = null;
    try {
        await assertMethodChatOrigin(
            db,
            link.project_id,
            { email: link.owner_email, activeRole: link.owner_role },
            { roomId: link.room_id, messageId: link.source_message_id },
            true,
            true,
        );
        if (result && typeof result === 'object' && Object.keys(result).length)
            publicResult = normalizeAgentMethodWorkflowResult(result, job.payload);
    } catch (error) {
        if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error;
        state = 'withheld';
    }
    await db.query('UPDATE project_chat_method_workflows SET publication_state=$2,public_result=$3 WHERE job_id=$1', [
        job.id,
        state,
        publicResult,
    ]);
    await db.query('UPDATE project_chat_rooms SET revision=revision+1,updated_at=now() WHERE project_id=$1 AND id=$2', [
        link.project_id,
        link.room_id,
    ]);
}
