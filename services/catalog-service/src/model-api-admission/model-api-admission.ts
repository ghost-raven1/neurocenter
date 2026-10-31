import { ForbiddenException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { IModel } from '../models/model.types';
import { ModelRateLimitsService } from '../model-rate-limits/model-rate-limits.service';
import { currentModelUsage } from '../model-usage/model-usage.context';
import { currentModelDispatchMetrics } from '../model-usage/model-dispatch-metrics';
import { readFeatures } from '../../../shared/feature-client.cjs';
import { requiredInferenceFeatures } from '../../../shared/feature-policy.cjs';
import { ModelUsageService } from '../model-usage/model-usage.service';
import type { ModelTokenQuotaEstimate } from '../model-token-quotas/model-token-quotas.types';
import { quotaCoverage } from '../model-token-quotas/model-token-quotas.model';
import { quotaUnavailable } from '../model-token-quotas/quota-database';
import { modelRateBeforeAttempt } from '../model-rate-limits/model-rate-limits.wait';
import type { ProviderWireLease } from '../model-usage/model-usage.context';

/** The transport calls this after metadata preflights, immediately before the physical provider action. */
@Injectable()
export class ModelApiAdmission {
    constructor(
        private readonly limits: ModelRateLimitsService,
        @Optional() private readonly usage?: ModelUsageService,
    ) {}
    async run<T>(
        model: IModel,
        signal: AbortSignal | undefined,
        action: () => Promise<T>,
        estimate?: () => ModelTokenQuotaEstimate,
    ): Promise<T> {
        const context = currentModelUsage(),
            metrics = currentModelDispatchMetrics();
        let quotaEnabled = false;
        const enforcement = async () => {
            let state: Awaited<ReturnType<typeof readFeatures>>;
            try {
                state = await readFeatures(process.env, globalThis.fetch, signal);
            } catch {
                signal?.throwIfAborted();
                throw new ServiceUnavailableException(
                    'Не удалось проверить доступность функции. Запрос модели не отправлен.',
                );
            }
            const keys = [
                ...requiredInferenceFeatures(context.purpose, context.agentId),
                ...(context.requiredFeatures ?? []),
            ];
            const disabled = keys.find((key) => !state.flags[key]);
            if (disabled)
                throw new ForbiddenException({
                    statusCode: 403,
                    code: 'feature-disabled',
                    feature: disabled,
                    blockedBy: state.blockedBy[disabled] ?? [],
                    message: 'Функция отключена администратором. Новый запрос модели не отправлен.',
                });
            quotaEnabled = state.flags.user_model_token_quotas && quotaCoverage(model).managedText;
            signal?.throwIfAborted();
            return state.flags.model_rate_limits;
        };
        const beforeAttempt = async () => {
            signal?.throwIfAborted();
            await context.beforeInference?.();
            signal?.throwIfAborted();
            return enforcement();
        };
        // OFF keeps provider calls usable even if the optional rate store is unavailable.
        let enabled = await enforcement();
        if (!enabled) enabled = await modelRateBeforeAttempt(beforeAttempt, signal);
        if (enabled)
            await this.limits.acquire(model, signal, beforeAttempt, (ms) => {
                if (metrics) metrics.rateWaitMs += ms;
            });
        // Unlike ongoing authority checks, this guard must never run after the provider has accepted work.
        await context.beforeDispatch?.();
        await modelRateBeforeAttempt(beforeAttempt, signal);
        let quotaChecked = false,
            entered: boolean,
            started: number,
            activeWrite: Promise<void> | undefined,
            wireLease: ProviderWireLease | undefined;
        try {
            if (quotaEnabled) {
                if (!this.usage || !estimate) throw quotaUnavailable();
                await this.usage.reserveQuota(model, estimate(), metrics, signal);
                quotaChecked = true;
                await context.beforeDispatch?.();
                await modelRateBeforeAttempt(beforeAttempt, signal);
            }
            // A newly enabled check cannot be bypassed by an earlier OFF snapshot.
            if (quotaEnabled && !quotaChecked) throw quotaUnavailable();
            // Rate waits and quota reservations precede the short credential/authority lock.
            // It stays held across claimQuota and is consumed at the remote client's literal fetch.
            if (context.providerWire) {
                wireLease = await context.providerWire.acquire(signal);
                context.providerWire.current = wireLease;
            }
            // This durable possible-send claim is last: no asynchronous authority callback may stale its policy.
            if (this.usage && quotaCoverage(model).managedText)
                await this.usage.claimQuota(metrics, quotaEnabled, signal);
            wireLease?.assertCurrent?.();
            signal?.throwIfAborted();
            if (metrics) {
                metrics.dispatchCount++;
                metrics.dispatchedAt ??= new Date().toISOString();
            }
            started = performance.now();
            entered = true;
        } catch (error) {
            if (context.providerWire && context.providerWire.current === wireLease) {
                context.providerWire.current = undefined;
                await wireLease?.release();
            }
            if (quotaChecked) await this.usage?.releaseQuota(metrics).catch(() => undefined);
            throw error;
        }
        // Recorders own their SQL deadline; neither an async rejection nor a sync callback failure replaces paid work.
        const progress = (active: boolean) =>
            Promise.resolve()
                .then(() => metrics?.progress?.(active))
                .catch(() => undefined);
        try {
            const request = action();
            activeWrite = progress(true);
            return await request;
        } finally {
            if (context.providerWire && context.providerWire.current === wireLease) {
                context.providerWire.current = undefined;
                await wireLease?.release();
            }
            if (metrics && entered) metrics.providerLatencyMs += Math.max(0, performance.now() - started);
            await activeWrite;
            await progress(false);
        }
    }
}
