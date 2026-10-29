import { ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import type { IModelInferenceRuntime } from '../models/model-runtime';
import type { ModelChatProjectContext } from '../model-chat/chat-project-context';
import type { ChatProjectEvidence, ChatProjectSource, PreparedProjectContext } from '../model-chat/chat-project-context.types';
import type { IChatContextSettings } from '../model-chat/chat-context';
import type { ChatMessage } from '../model-chat/chat.types';
import { withModelUsage } from '../model-usage/model-usage.context';
import { requireFeatureEnabled, requireFeaturesEnabled } from '../features/require-feature-enabled';
import { ROLE_BUDGET, ROLE_RAG_POLICY, SYSTEM_ROLE_DEFINITIONS, systemRole } from './system-role.definitions';
import type { RoleDb } from './system-role.repository';
import { roleProjection } from './system-role.privacy';
import type { RoleProjectEvidence, RoleProjectGrant, RoleRunRow, SystemRoleId } from './system-role.types';

// Three 4096-byte child answers plus their receipts and the 8192-byte summary fit the existing 32KiB result row.
const RECEIPT_BYTES = ROLE_RAG_POLICY.receiptBytes;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const sourceReceipt = ({ id, path, title, startLine, endLine }: ChatProjectSource): RoleProjectEvidence['sources'][number] => ({ id, path,
    ...(title === undefined ? {} : { title }), ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) });

/** One accepted grant and one memoized retrieval serve the whole durable run, including tools and delegates. */
export class SystemRoleRagContext {
    private retrieval?: Promise<PreparedProjectContext>;
    readonly requiredFeatures: readonly ('project_search'|'project_text_knowledge')[];
    constructor(private readonly context: ModelChatProjectContext | undefined, private readonly req: Request, private readonly row: RoleRunRow,
        private readonly signal: AbortSignal, private readonly checkpoint: () => Promise<unknown>, private readonly embed: IModelInferenceRuntime['infer']) {
        this.requiredFeatures = row.snapshot.projectContext ? [row.snapshot.projectContext.scope==='project-text'?'project_text_knowledge':'project_search'] : [];
    }
    private grant(): RoleProjectGrant | undefined {
        const grant = this.row.snapshot.projectContext;
        if (grant && (!this.context || !['project-index','project-text'].includes(grant.scope)||grant.scope==='project-text'&&!grant.textContext || grant.projectId !== this.row.project_id
            || !grant.recipients.length || grant.recipients.some(id => !SYSTEM_ROLE_DEFINITIONS.some(role => role.id === id)))) {
            throw new ConflictException('Разрешение базы знаний не соответствует принятому запуску. Подготовьте контекст заново.');
        }
        return grant;
    }
    async assertCurrent(db?: RoleDb): Promise<void> {
        this.signal.throwIfAborted(); const grant = this.grant();
        if (grant){
            if(grant.scope==='project-text')await this.context!.assertTextIdentity(this.req,grant.projectId,grant.textContext!,grant.identity);
            else await this.context!.assertIdentity(this.req, grant.projectId, grant.identity, this.signal, db);
        }
    }
    async beforeInference(): Promise<void> {
        const grant=this.grant();if (grant) { await requireFeatureEnabled(grant.scope==='project-text'?'project_text_knowledge':'project_search'); await this.assertCurrent(); }
    }
    private load(grant: RoleProjectGrant, callSignal: AbortSignal): Promise<PreparedProjectContext> {
        return this.retrieval ??= withModelUsage({ purpose: 'agent', actorEmail: this.row.actor, actorRole: this.row.actor_role,
            projectId: grant.projectId, agentId: this.row.agent_id, operationId: this.row.id,
            requiredFeatures: [...this.requiredFeatures, systemRole(this.row.agent_id).flag,
                ...(this.row.request.sourceFeature ? [this.row.request.sourceFeature] : [])],
            beforeInference: async () => { await this.checkpoint(); await this.beforeInference(); } }, () => grant.scope==='project-text'
                ? this.context!.prepareText(this.req,grant.projectId,grant.textContext!,AbortSignal.any([this.signal,callSignal]))
                : this.context!.prepare(this.req,
            grant.projectId, roleProjection(this.row.snapshot.selection.instruction).content, AbortSignal.any([this.signal, callSignal]), async () => {
                await this.checkpoint(); await requireFeaturesEnabled([systemRole(this.row.agent_id).flag, ...this.requiredFeatures,
                    ...(this.row.request.sourceFeature ? [this.row.request.sourceFeature] : [])], process.env, globalThis.fetch, callSignal);
            },
            (model, body, signal) => this.embed(model, 'embed', body, signal), grant.identity));
    }
    /** No target/path ACL is inferred: only explicitly approved project-index recipients receive this channel. */
    async fit(id: SystemRoleId, messages: ChatMessage[], settings: IChatContextSettings, planning = false, callSignal = this.signal): Promise<{ messages: ChatMessage[]; projectContext?: RoleProjectEvidence }> {
        const grant = this.grant();
        if (!grant || planning || !grant.recipients.includes(id)) return { messages };
        const prepared = await this.load(grant, callSignal);
        const allowed = new Map<string, ChatProjectSource>();
        for (const source of prepared.evidence.sources) {
            // Paths/IDs are provenance, never executable URLs. Credential-bearing metadata is omitted, not relabelled.
            if ([source.id, source.path, source.title ?? ''].some(text => roleProjection(text).content !== text)) continue;
            const projected = { ...source, excerpt: roleProjection(source.excerpt).content };
            const candidate = { ...prepared.evidence, sources: [...allowed.values(), projected] };
            if (bytes(this.receipt(grant, candidate)) <= RECEIPT_BYTES) allowed.set(source.id, projected);
        }
        const fit = prepared.fit(messages, settings, { maxBytes: ROLE_BUDGET.contextBytes, projectSource: source => allowed.get(source.id) ?? null });
        return { messages: fit.messages, projectContext: this.receipt(grant, fit.evidence) };
    }
    private receipt(grant: RoleProjectGrant, evidence: ChatProjectEvidence): RoleProjectEvidence {
        return { status: evidence.status === 'none' ? 'metadata' : evidence.status,
            project: { id: grant.projectId, name: grant.projectName },
            ...(evidence.mode==='text'?{mode:'text',textRevision:evidence.textRevision,corpusHash:evidence.corpusHash}:{}),
            ...(grant.generation ? { generation: grant.generation } : {}), ...(grant.snapshot ? { snapshot: grant.snapshot } : {}),
            sources: evidence.sources.map(sourceReceipt), ...(evidence.message ? { message: evidence.message } : {}) };
    }
}

/** Synthesis may cite only metadata actually carried in its own prompt or validated completed child answers. */
export function synthesisProjectEvidence(own: RoleProjectEvidence | undefined, children: Array<RoleProjectEvidence | undefined>): RoleProjectEvidence | undefined {
    const receipts = [own, ...children].filter((value): value is RoleProjectEvidence => !!value);
    if (!receipts.length) return undefined;
    const result: RoleProjectEvidence = { ...receipts[0], sources: [] };
    for (const receipt of receipts) {
        if (receipt.project.id !== result.project.id || receipt.generation !== result.generation || receipt.snapshot !== result.snapshot
            ||receipt.mode!==result.mode||receipt.textRevision!==result.textRevision||receipt.corpusHash!==result.corpusHash) throw new ConflictException('Источники делегатов относятся к разным снимкам проекта.');
        for (const source of receipt.sources) {
            if (result.sources.some(item => item.id === source.id)) continue;
            const candidate = { ...result, status: 'ready' as const, sources: [...result.sources, source] };
            if (candidate.sources.length <= ROLE_RAG_POLICY.maxSources && bytes(candidate) <= RECEIPT_BYTES) Object.assign(result, candidate);
        }
    }
    return result;
}
