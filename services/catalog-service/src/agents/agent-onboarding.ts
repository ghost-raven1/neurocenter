import type { Pool, PoolClient } from 'pg';
import { createLearningContext } from '../../../shared/project-learning.cjs';
import type { IAgentExtension, IAgentDefinition } from '../../../shared/project-agents.cjs';
import { LearningRepository } from '../learning/learning.repository';
import { resolveAgentExtensionKit } from './agent-extension-kit';
import type { IProjectAgentAssignment } from './agent.interfaces';

type TDb = Pick<PoolClient, 'query'>;

/**
 * FR-307: operator-free self-onboarding. Adding an agent to a project auto-configures its role,
 * approved-knowledge context (FR-502), catalog tool profile (FR-306, consumed from the agt-08 kit)
 * and public-chat access — with zero manual operator steps (R2 counter: an admin-initiated add is
 * initiation, not operator intervention). The resolver below is the single source of truth for what
 * "self-configured" means; it reads only the pinned card, the approved learning context, and the
 * per-agent extension kit, so onboarding never duplicates catalog (epic 2) or device/pairing (epic 7).
 */

export const C2_INTERIM_TARGET_MS = 5 * 60 * 1000;

export type TOnboardingContextStatus = 'approved' | 'empty' | 'blocked';
export type TOnboardingPublicChatStatus = 'active' | 'disabled';

export interface IOnboardingContext {
    status: TOnboardingContextStatus;
    /** SHA-256 of the agent-scoped approved bundle (null unless status='approved'). */
    digest: string | null;
    revision: number | null;
    entries: number;
}
export interface IOnboardingTools {
    count: number;
    extensions: IAgentExtension[];
}
export interface IOnboardingPublicChat {
    enabled: boolean;
    status: TOnboardingPublicChatStatus;
}
export interface IAgentOnboardingConfig {
    /** Role inherited from the pinned card version (mode); self-configured, never operator-set. */
    role: IAgentDefinition['mode'];
    roleSource: 'pinned-card';
    context: IOnboardingContext;
    tools: IOnboardingTools;
    publicChat: IOnboardingPublicChat;
}

interface IOnboardingRow {
    project_id: string;
    agent_id: string;
    agent_version: number;
    agent_manifest: string;
    role: string;
    role_source: string;
    context_status: string;
    context_digest: string | null;
    context_revision: number | null;
    context_entries: number;
    tools_count: number;
    tools: IAgentExtension[];
    public_chat_enabled: boolean;
    public_chat_status: string;
    onboarded_at: Date;
    added_by: string;
}

/**
 * Resolve the approved-knowledge context for an agent (FR-502): only approved, active entries enter
 * the onboarding context. Agent-scoped = entries with a null target (shared) or targeting this agent.
 * `context()` already throws when an active candidate lacks a valid approval — that maps to 'blocked'.
 */
async function resolveContext(db: TDb, pool: Pool, projectId: string, agentId: string): Promise<IOnboardingContext> {
    try {
        const bundle = await new LearningRepository(pool).context(db, projectId);
        const scoped = bundle.entries.filter(
            (entry) => entry.targetAgentId === null || entry.targetAgentId === agentId,
        );
        if (!scoped.length) return { status: 'empty', digest: null, revision: bundle.revision, entries: 0 };
        const scopedBundle = createLearningContext({
            projectId,
            revision: bundle.revision,
            entries: scoped,
        });
        return {
            status: 'approved',
            digest: scopedBundle.digest,
            revision: bundle.revision,
            entries: scoped.length,
        };
    } catch {
        return { status: 'blocked', digest: null, revision: null, entries: 0 };
    }
}

/**
 * Resolve the full self-onboarding configuration for an assignment. Pure read: the role comes from the
 * pinned card, the context from the approved learning bundle, the tools from the agt-08 kit, and
 * public-chat access from the assignment's enabled flag (auto-enabled at assign).
 */
export async function resolveAgentOnboarding(
    db: TDb,
    pool: Pool,
    projectId: string,
    agentId: string,
    assignment: Pick<IProjectAgentAssignment, 'effective' | 'enabled' | 'removed'>,
): Promise<IAgentOnboardingConfig> {
    const context = await resolveContext(db, pool, projectId, agentId);
    const extensions = await resolveAgentExtensionKit(db, projectId, agentId);
    const enabled = assignment.enabled && !assignment.removed;
    return {
        role: assignment.effective.mode,
        roleSource: 'pinned-card',
        context,
        tools: { count: extensions.length, extensions },
        publicChat: { enabled, status: enabled ? 'active' : 'disabled' },
    };
}

/**
 * Record the onboarding snapshot at assign time. Idempotent: the first onboarding (t0 for C2) wins;
 * re-adding an agent does not reset the anchor. Written in the assign transaction.
 */
export async function persistAgentOnboarding(
    db: TDb,
    projectId: string,
    agentId: string,
    assignment: Pick<IProjectAgentAssignment, 'version' | 'manifest' | 'enabled' | 'removed'>,
    config: IAgentOnboardingConfig,
    actor: string,
): Promise<void> {
    await db.query(
        `INSERT INTO agent_onboarding(
            project_id,agent_id,agent_version,agent_manifest,role,role_source,
            context_status,context_digest,context_revision,context_entries,
            tools_count,tools,public_chat_enabled,public_chat_status,added_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
        ON CONFLICT(project_id,agent_id) DO NOTHING`,
        [
            projectId,
            agentId,
            assignment.version,
            assignment.manifest,
            config.role,
            config.roleSource,
            config.context.status,
            config.context.digest,
            config.context.revision,
            config.context.entries,
            config.tools.count,
            JSON.stringify(config.tools.extensions),
            config.publicChat.enabled,
            config.publicChat.status,
            actor,
        ],
    );
}

export interface IAgentOnboardingRecord {
    projectId: string;
    agentId: string;
    agentVersion: number;
    agentManifest: string;
    role: string;
    roleSource: string;
    context: IOnboardingContext;
    tools: IOnboardingTools;
    publicChat: IOnboardingPublicChat;
    onboardedAt: string;
    addedBy: string;
}
export async function readAgentOnboarding(
    db: TDb,
    projectId: string,
    agentId: string,
): Promise<IAgentOnboardingRecord | null> {
    const row = (
        await db.query<IOnboardingRow>('SELECT * FROM agent_onboarding WHERE project_id=$1 AND agent_id=$2', [
            projectId,
            agentId,
        ])
    ).rows[0];
    if (!row) return null;
    return {
        projectId: row.project_id,
        agentId: row.agent_id,
        agentVersion: Number(row.agent_version),
        agentManifest: row.agent_manifest,
        role: row.role,
        roleSource: row.role_source,
        context: {
            status: row.context_status as IOnboardingContext['status'],
            digest: row.context_digest,
            revision: row.context_revision === null ? null : Number(row.context_revision),
            entries: Number(row.context_entries),
        },
        tools: { count: Number(row.tools_count), extensions: row.tools },
        publicChat: {
            enabled: row.public_chat_enabled,
            status: row.public_chat_status as IOnboardingPublicChat['status'],
        },
        onboardedAt: new Date(row.onboarded_at).toISOString(),
        addedBy: row.added_by,
    };
}

/**
 * The first useful operation (C2 t1): the first *completed* project-chat response of the agent.
 * A readiness trial is a diagnostic, not an operation; a bridge job is configuration delivery, not an
 * operation. The completed public-chat answer is the first output that is actually useful to the team,
 * so it is the defensible t1 anchor. Derived at read time from already-recorded events — never written.
 */
export async function firstUsefulChatAt(db: TDb, projectId: string, agentId: string): Promise<Date | null> {
    const row = (
        await db.query<{ first_useful_at: Date | null }>(
            `SELECT MIN(r.updated_at) AS first_useful_at
            FROM model_chat_agent_responses r
            JOIN model_chat_conversations c ON c.id = r.conversation_id
            WHERE r.agent_id=$2 AND c.project_id=$1 AND r.status='done'`,
            [projectId, agentId],
        )
    ).rows[0];
    return row?.first_useful_at ?? null;
}

export interface IFirstUsefulTiming {
    onboardedAt: string;
    firstUsefulAt: string | null;
    deltaMs: number | null;
    withinTarget: boolean | null;
    targetMs: number;
}

/**
 * Pure C2 timing measurement: from the onboarding anchor (t0) to the first useful operation (t1).
 * Testable without a real opencode binary or database — feed two timestamps and assert the delta and
 * the interim threshold (OQ-1: <= 5 minutes; the final target is fixed in baseline Q7).
 */
export function measureFirstUsefulOperation(
    onboardedAt: string | Date,
    firstUsefulAt: string | Date | null,
    targetMs: number = C2_INTERIM_TARGET_MS,
): IFirstUsefulTiming {
    const t0 = new Date(onboardedAt).getTime();
    if (firstUsefulAt === null)
        return {
            onboardedAt: new Date(onboardedAt).toISOString(),
            firstUsefulAt: null,
            deltaMs: null,
            withinTarget: null,
            targetMs,
        };
    const t1 = new Date(firstUsefulAt).getTime();
    const deltaMs = t1 - t0;
    return {
        onboardedAt: new Date(onboardedAt).toISOString(),
        firstUsefulAt: new Date(firstUsefulAt).toISOString(),
        deltaMs,
        withinTarget: deltaMs >= 0 && deltaMs <= targetMs,
        targetMs,
    };
}
