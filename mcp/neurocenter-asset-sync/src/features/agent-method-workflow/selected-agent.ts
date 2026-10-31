import { isDeepStrictEqual } from 'node:util';
import { InstallationPlan } from '../../bridge/installation-plan.js';
import { hash } from '../../bridge/state.js';
import { readOpenCodeModelMetadata } from '../../bridge/opencode-model-scan.js';
import { hasUnsafeOpenCodeWarnings } from '../../bridge/opencode-scan-warnings.js';
import { extractFrontmatter } from '../../lib/frontmatter.js';
import { AGENTS_RECEIPT, agentFile, agentsPrivateProof } from '../project-agents/receipt.js';
import { assertAgentNamespace } from '../project-agents/namespace.js';
import { normalizeProjectAgentModelMapping } from '../project-agents/contract.js';
import type { AgentMethodWorkflowPayload } from './contract.js';
import { MethodExecutionError } from './process.js';

const unavailable = () => new MethodExecutionError('SELECTED_AGENT_NOT_READY');
/** A selected agent is read-only verified against the committed local compilation, actual bytes and effective model metadata. */
export async function assertSelectedMethodAgent(
    root: string,
    payload: AgentMethodWorkflowPayload,
    authorize: () => Promise<unknown>,
): Promise<void> {
    const selected = payload.agent;
    if (!selected) return;
    await authorize();
    try {
        const plan = new InstallationPlan(root),
            proof = await agentsPrivateProof(root, payload.projectId),
            receipt = proof?.receipt;
        if (
            !proof ||
            !receipt ||
            receipt.schemaVersion !== 2 ||
            receipt.projectId !== payload.projectId ||
            receipt.bindingId !== payload.bindingId ||
            receipt.instanceId !== payload.instanceId ||
            receipt.revision !== selected.agentsRevision ||
            receipt.manifestSha256 !== selected.agentsManifestSha256 ||
            receipt.compiledManifestSha256 !== selected.compiledManifestSha256 ||
            (await plan.read(AGENTS_RECEIPT)) !== proof.raw
        )
            throw unavailable();
        const agent = receipt.agents.find((agent) => agent.id === selected.agentId);
        if (
            !agent ||
            !agent.enabled ||
            agent.slug !== selected.slug ||
            agent.version !== selected.version ||
            agent.sha256 !== selected.fileSha256
        )
            throw unavailable();
        const bytes = await plan.read(agentFile(selected.slug));
        if (bytes === null || hash(bytes) !== selected.fileSha256) throw unavailable();
        const header = extractFrontmatter(bytes),
            selector = selected.model.provider + '/' + selected.model.configKey;
        if (
            !header ||
            header.mode !== selected.mode ||
            !['primary', 'all'].includes(selected.mode) ||
            header.disable !== false ||
            header.model !== selector
        )
            throw unavailable();
        await assertAgentNamespace(
            plan,
            [selected.slug],
            receipt.agents.map((agent) => agent.slug),
            payload,
        );
        const scan = await readOpenCodeModelMetadata(
            root,
            {
                scope: 'project',
                projectId: payload.projectId,
                bindingId: payload.bindingId,
                instanceId: payload.instanceId,
            },
            { authorize, readAuth: false, requestedSelectors: [selector] },
        );
        if (hasUnsafeOpenCodeWarnings(scan.warnings)) throw unavailable();
        const candidates = scan.candidates.filter(
            (candidate) =>
                candidate.provider === selected.model.provider &&
                (candidate.configKey ?? candidate.model) === selected.model.configKey,
        );
        if (candidates.length !== 1) throw unavailable();
        const candidate = candidates[0]!;
        if (
            candidate.blocker &&
            !['codex-local-auth', 'local-provider-auth', 'device-local-endpoint'].includes(candidate.blocker)
        )
            throw unavailable();
        const mapping = normalizeProjectAgentModelMapping({
            agentId: selected.agentId,
            provider: candidate.provider,
            configKey: candidate.configKey ?? candidate.model,
            runtime: candidate.runtime,
            model: candidate.model,
            baseUrl: candidate.baseUrl,
            options: candidate.options ?? {},
            capability: candidate.capability,
        });
        if (!isDeepStrictEqual(mapping, selected.model)) throw unavailable();
        await plan.verifySnapshot();
        if ((await agentsPrivateProof(root, payload.projectId))?.raw !== proof.raw) throw unavailable();
        await authorize();
    } catch (error) {
        if (error instanceof MethodExecutionError) throw error;
        throw unavailable();
    }
}
