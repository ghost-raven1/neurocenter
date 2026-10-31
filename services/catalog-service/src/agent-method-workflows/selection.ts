import { BadRequestException, ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import {
    createProjectAgentsPayload,
    compileProjectAgents,
    normalizeProjectAgentsPayload,
    validateProjectAgentsResult,
    PROJECT_AGENTS_JOB,
} from '../../../shared/project-agents.cjs';
import type { AgentMethodWorkflowAgent, AgentMethodWorkflowPayload } from '../../../shared/agent-method-workflow.cjs';
import { ProjectAgentRepository } from '../agents/project-agent.repository';
import { agentModelRequirements, agentModelSetupRequired } from '../agents/agent-model-requirements';
import { agentId } from '../agents/agent-validation';
import type { Device } from '../devices/device-store';

export type MethodAgentDb = Pick<PoolClient, 'query'>;
interface Selection {
    projectId: string;
    bindingId: string;
    instanceId: string;
    agentId: unknown;
    expectedAgentsRevision: unknown;
}
interface Delivery {
    id: string;
    state: string;
    payload: unknown;
    result: unknown;
}
const stale = () =>
    new ConflictException(
        'Настройка выбранного агента изменилась или ещё не применена к этой папке. Примените актуальные настройки агентов и выберите задачу заново.',
    );
const database = (db: MethodAgentDb | undefined): MethodAgentDb => {
    if (!db) throw stale();
    return db;
};

/** Bind one enabled native profile to the current desired set and its latest successful exact delivery. */
export async function captureMethodAgent(
    db: MethodAgentDb | undefined,
    device: Device,
    selection: Selection,
): Promise<AgentMethodWorkflowAgent> {
    const source = database(db),
        id = selection.agentId;
    agentId(id);
    if (!Number.isSafeInteger(selection.expectedAgentsRevision) || Number(selection.expectedAgentsRevision) < 1)
        throw new BadRequestException('Выберите агента из актуальной ревизии проекта.');
    // Transactional callers retain this lock through enqueue/completion, fencing concurrent desired-state edits.
    const locked = (
        await source.query<{ revision: number }>(
            'SELECT revision FROM project_agent_sets WHERE project_id=$1 FOR SHARE',
            [selection.projectId],
        )
    ).rows[0];
    if (Number(locked?.revision) !== selection.expectedAgentsRevision) throw stale();
    const snapshot = await new ProjectAgentRepository(source as Pool).snapshot(selection.projectId, source);
    if (snapshot.revision !== selection.expectedAgentsRevision) throw stale();
    const agent = snapshot.agents.find((item) => item.id === id);
    if (!agent?.enabled)
        throw new ConflictException('Выбранный агент выключен или удалён из проекта. Выберите включённого агента.');
    const head = (
        await source.query<{ archived_at: unknown }>('SELECT archived_at FROM agent_catalog WHERE id=$1 FOR SHARE', [
            id,
        ])
    ).rows[0];
    if (!head || head.archived_at !== null)
        throw new ConflictException('Выбранный агент находится в архиве. Выберите действующего агента.');
    if (!['primary', 'all'].includes(agent.mode))
        throw new ConflictException(
            'Для выполнения задачи выберите основного агента или режим «Все». Подагент не заменяется агентом по умолчанию.',
        );
    if (!agent.model) throw agentModelSetupRequired(id);
    const modelRequirements = await agentModelRequirements(source, selection.projectId, snapshot.agents, device);
    const desired = createProjectAgentsPayload({
        schemaVersion: 2,
        projectId: selection.projectId,
        bindingId: selection.bindingId,
        instanceId: selection.instanceId,
        ...snapshot,
        modelRequirements,
    });
    const delivered = (
        await source.query<Delivery>(
            `SELECT id,state,payload,result FROM bridge_jobs
  WHERE device_id=$1 AND email=$2 AND project_id=$3 AND kind=$4 AND payload->>'bindingId'=$5 AND payload->>'instanceId'=$6
  ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
            [
                device.id,
                device.email,
                selection.projectId,
                PROJECT_AGENTS_JOB,
                selection.bindingId,
                selection.instanceId,
            ],
        )
    ).rows[0];
    if (!delivered || delivered.state !== 'succeeded') throw stale();
    try {
        const applied = normalizeProjectAgentsPayload(delivered.payload),
            { compilation, ...base } = applied;
        if (!compilation || !isDeepStrictEqual(base, desired)) throw stale();
        const compiled = compileProjectAgents(desired, compilation.mappings);
        if (!isDeepStrictEqual(compilation, compiled)) throw stale();
        validateProjectAgentsResult(delivered.result, { ...desired, compilation: compiled });
        const native = compiled.agents.find((item) => item.id === id),
            model = compiled.mappings.find((item) => item.agentId === id);
        if (!native?.enabled || !model) throw stale();
        return {
            agentId: id,
            slug: agent.slug,
            version: agent.version,
            mode: agent.mode as 'primary' | 'all',
            agentsRevision: snapshot.revision,
            agentsManifestSha256: desired.manifestSha256,
            compiledManifestSha256: compiled.manifestSha256,
            fileSha256: native.sha256,
            configurationJobId: delivered.id,
            model,
        };
    } catch {
        throw stale();
    }
}

/** Server freshness never grants a fallback: accepted selected jobs must keep their exact original identity. */
export async function assertMethodAgent(
    db: MethodAgentDb | undefined,
    device: Device,
    payload: AgentMethodWorkflowPayload,
): Promise<void> {
    if (!payload.agent) return;
    const current = await captureMethodAgent(db, device, {
        projectId: payload.projectId,
        bindingId: payload.bindingId,
        instanceId: payload.instanceId,
        agentId: payload.agent.agentId,
        expectedAgentsRevision: payload.agent.agentsRevision,
    });
    if (!isDeepStrictEqual(current, payload.agent)) throw stale();
}
