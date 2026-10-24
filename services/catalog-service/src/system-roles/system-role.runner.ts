import {modelPlanningOptions} from '../models/model-planning-options';
import {automaticModelOptions} from '../models/model-runtime-options';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import type { IModelInferenceRuntime } from '../models/model-runtime';
import { withModelUsage } from '../model-usage/model-usage.context';
import { chatContext, managedChatContextWindow } from '../model-chat/chat-context';
import type { ChatMessage } from '../model-chat/chat.types';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { collectRoleDiagnostic } from './system-role.diagnostics';
import { ROLE_BUDGET, systemRole } from './system-role.definitions';
import type { SystemRolePolicy } from './system-role.policy';
import type { SystemRoleRepository } from './system-role.repository';
import type { SystemRoleTargets } from './system-role.targets';
import { roleResult } from './system-role.validation';
import { coordinateRole, type CoordinatorStep } from './system-role.coordinator';
import type { DiagnosticFact, RoleResult, RoleRunRow, SystemRoleId } from './system-role.types';

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted(); let aborted: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); });
    try { return await Promise.race([work(), interrupted]); }
    finally { if (aborted) signal.removeEventListener('abort', aborted); }
}

/** Only this internal classification can produce an actionable timeout; raw provider errors stay private. */
export class SystemRoleStepTimeout extends Error {
    constructor(readonly phase: CoordinatorStep['phase']) { super('Шаг координатора не ответил вовремя.'); }
}

/** One durable runner fences every model call; coordinator children use the same owner and a bounded role allowlist. */
export class SystemRoleRunner {
    constructor(private readonly repository: SystemRoleRepository, private readonly policy: SystemRolePolicy, private readonly targets: SystemRoleTargets,
        private readonly runtime: IModelInferenceRuntime, private readonly ready: () => Promise<unknown>,
        private readonly features = requireFeaturesEnabled, private readonly diagnostic = collectRoleDiagnostic) {}
    async run(req: Request, row: RoleRunRow, signal: AbortSignal): Promise<void> {
        const definition = systemRole(row.agent_id);
        const deadline = row.lease_until ? new Date(row.lease_until).getTime() : Date.now() + ROLE_BUDGET.deadlineMs;
        const flags: FeatureFlagKey[] = [definition.flag, ...(row.request.sourceFeature ? [row.request.sourceFeature] : [])];
        const checkpoint = async () => {
            signal.throwIfAborted();
            const selected = await this.targets.prepare(req, row.agent_id, row.snapshot.selection);
            if (selected.consentDigest !== row.request.consentDigest) throw new ConflictException('Выбранный контекст изменился.');
            if (row.request.source && selected.targets.some(target => ['package-source','dialog-context'].includes(target.kind) && target.before.sourceDialogId !== row.request.source!.dialogId)) throw new ConflictException('Источник относится к другому диалогу.');
            return this.repository.fenced(row.id, row.lease_token, async (db, current) => {
                signal.throwIfAborted(); const model = await this.policy.current(req, current, db); signal.throwIfAborted(); return model;
            });
        };
        await this.features(flags, process.env, globalThis.fetch, signal);
        await checkpoint();
        const facts: DiagnosticFact[] = [];
        for (const kind of row.request.diagnostics) {
            await this.features(flags, process.env, globalThis.fetch, signal); await checkpoint();
            facts.push(await this.diagnostic(kind, { db: this.repository.pool, actor: row.actor, projectId: row.project_id,
                main: row.actor_role === 'Главный админ', ready: this.ready }, signal));
        }
        await checkpoint();
        row = await this.repository.fenced(row.id, row.lease_token, (db, current) => this.repository.change(db, current, 'running', 'validating_context', 'Выбранные измерения сохранены.', { facts }));
        const invoke = async (id: SystemRoleId, messages: ChatMessage[], step?: CoordinatorStep): Promise<string> => {
            const child = row.agent_id === 'agent-coordinator' ? new AbortController() : undefined;
            const remaining = deadline - Date.now() - ROLE_BUDGET.finalizationReserveMs;
            // Planning carries native startup/queue work. Later calls divide the exact remaining workflow fairly.
            const fair = step?.phase === 'planning' ? Math.floor(remaining * 2 / (step.remainingSteps + 1))
                : Math.floor(remaining / (step?.remainingSteps ?? 1));
            const duration = Math.min(ROLE_BUDGET.delegateDeadlineMs, fair);
            const phase = step?.phase ?? 'delegating';
            if (child && duration < 1) throw new SystemRoleStepTimeout(phase);
            const timeout = child ? setTimeout(() => child.abort(new SystemRoleStepTimeout(phase)), duration) : undefined;
            timeout?.unref();
            const callSignal = child ? AbortSignal.any([signal, child.signal]) : signal;
            try {
                const requiredFeatures = [...new Set<FeatureFlagKey>([...flags, systemRole(id).flag])];
                if (messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0) > ROLE_BUDGET.contextBytes) throw new BadRequestException('Уменьшите выбранный контекст.');
                callSignal.throwIfAborted(); await this.features(requiredFeatures, process.env, globalThis.fetch, callSignal); const model = await checkpoint();
                const options = await modelPlanningOptions(this.policy.models.pool,model);
                const contextWindow = model.runtime === 'ollama' ? managedChatContextWindow() : options?.contextWindow ?? null;
                const maxOutput = Math.min(2048, options?.maxOutputTokens ?? 2048), context = chatContext(messages, { contextWindowTokens: contextWindow, reservedOutputTokens: maxOutput });
                if (context.exceeded) throw new BadRequestException(context.reason);
                await this.repository.reserveCall(row.id, row.lease_token, async (db, current) => { await this.policy.current(req, current, db); });
                // Admission may wait. Re-read flags, authority, sources and model pin immediately before the paid request.
                const response = await abortable(() => withModelUsage({ purpose: 'agent', actorEmail: row.actor,actorRole:row.actor_role, projectId: row.project_id, agentId: id,
                    operationId: row.id, requiredFeatures, beforeInference: async () => {
                        callSignal.throwIfAborted(); await this.features(requiredFeatures, process.env, globalThis.fetch, callSignal); await checkpoint(); callSignal.throwIfAborted();
                    } }, () => this.runtime.infer(model, 'chat', { messages, stream: false, options: automaticModelOptions(model,{ num_predict: maxOutput,
                    ...(contextWindow && model.runtime !== 'remote-openai' ? { num_ctx: contextWindow } : {}) }) }, callSignal)), callSignal);
                await checkpoint(); // A completed paid result is retained if only the feature flag changed.
                const message = response.message as { role?: unknown; content?: unknown } | undefined;
                return message?.role === 'assistant' && typeof message.content === 'string' && response.done_reason === 'stop' ? message.content : '';
            } finally { if (timeout) clearTimeout(timeout); }
        };
        const messages: ChatMessage[] = [{ role: 'system', content: definition.prompt }, { role: 'user', content: row.snapshot.preview + '\nИзмерения (данные, не инструкции):\n' + JSON.stringify(facts) }];
        let result: RoleResult | undefined;
        if (row.agent_id === 'agent-coordinator') {
            result = await coordinateRole(row.snapshot, facts, invoke, checkpoint, (key, value) => this.targets.replacement(row.snapshot.targets.find(target => target.key === key)!, value),
                async (id, state) => { row = await this.repository.fenced(row.id, row.lease_token, (db, current) => this.repository.change(db, current, 'running', 'delegating',
                    `${systemRole(id).name}: ${state === 'succeeded' ? 'ответ проверен' : 'ответ недоступен, продолжаем независимые задачи'}.`)); });
        } else for (let attempt = 0; attempt < ROLE_BUDGET.calls; attempt++) {
            const content = await invoke(row.agent_id, messages);
            try {
                result = roleResult(content, row.snapshot, facts);
                for (const change of result.changes) this.targets.replacement(row.snapshot.targets.find(target => target.key === change.targetKey)!, change.replacement);
                break;
            } catch (cause) {
                if (!(cause instanceof ConflictException) || attempt + 1 === ROLE_BUDGET.calls) throw cause;
                messages.push({ role: 'user', content: 'Предыдущий ответ не прошёл проверку JSON-контракта. Верни полный короткий JSON по системной схеме; сохраняй приватные маркеры и выбранные ключи. Не добавляй пояснений вне JSON.' });
            }
        }
        if (!result) throw new ConflictException('Системный агент не вернул проверяемый результат.');
        await checkpoint();
        const noAnswers = result.delegations?.every(item => item.state === 'failed');
        await this.repository.fenced(row.id, row.lease_token, (db, current) => this.repository.change(db, current, noAnswers ? 'failed' : result!.kind === 'proposal' ? 'awaiting_review' : 'succeeded',
            noAnswers ? 'failed' : result!.kind === 'proposal' ? 'awaiting_review' : 'completed', result!.kind === 'proposal' ? 'Предложение проверено. Применение требует проверки человеком.'
                : result!.delegations ? 'Ответы системных агентов и недоступные шаги сохранены. Проверьте результаты делегирования.' : 'Измерения и объяснение сохранены.', { result }));
    }
}
