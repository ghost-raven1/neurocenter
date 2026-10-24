import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { IModel } from '../models/model.types';
import { ModelRateLimitsService } from '../model-rate-limits/model-rate-limits.service';
import { currentModelUsage } from '../model-usage/model-usage.context';
import { currentModelDispatchMetrics } from '../model-usage/model-dispatch-metrics';
import { readFeatures } from '../../../shared/feature-client.cjs';
import { requiredInferenceFeatures } from '../../../shared/feature-policy.cjs';
import { modelRateBeforeAttempt } from '../model-rate-limits/model-rate-limits.wait';

/** The transport calls this after metadata preflights, immediately before the physical provider action. */
@Injectable()
export class ModelApiAdmission {
 constructor(private readonly limits: ModelRateLimitsService) {}
 async run<T>(model: IModel, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const context = currentModelUsage(), metrics = currentModelDispatchMetrics();
  const enforcement = async () => {
   let state: Awaited<ReturnType<typeof readFeatures>>;
   try { state = await readFeatures(process.env, globalThis.fetch, signal); }
   catch { signal?.throwIfAborted(); throw new ServiceUnavailableException('Не удалось проверить доступность функции. Запрос модели не отправлен.'); }
   const keys = [...requiredInferenceFeatures(context.purpose, context.agentId), ...(context.requiredFeatures ?? [])];
   const disabled = keys.find(key => !state.flags[key]);
   if (disabled) throw new ForbiddenException({ statusCode: 403, code: 'feature-disabled', feature: disabled, blockedBy: state.blockedBy[disabled] ?? [], message: 'Функция отключена администратором. Новый запрос модели не отправлен.' });
   signal?.throwIfAborted(); return state.flags.model_rate_limits;
  };
  const beforeAttempt = async () => {
   signal?.throwIfAborted(); await context.beforeInference?.(); signal?.throwIfAborted(); return enforcement();
  };
  // OFF keeps provider calls usable even if the optional rate store is unavailable.
  let enabled = await enforcement();
  if (!enabled) enabled = await modelRateBeforeAttempt(beforeAttempt, signal);
  if (enabled) await this.limits.acquire(model, signal, beforeAttempt, ms => { if (metrics) metrics.rateWaitMs += ms; });
  signal?.throwIfAborted();
  if (metrics) { metrics.dispatchCount++; metrics.dispatchedAt ??= new Date().toISOString(); }
  const started=performance.now();let activeWrite:Promise<void>|undefined;
  // Recorders own their SQL deadline; neither an async rejection nor a sync callback failure replaces paid work.
  const progress=(active:boolean)=>Promise.resolve().then(()=>metrics?.progress?.(active)).catch(()=>undefined);
  try {
   const request=action();activeWrite=progress(true);return await request;
  }
  finally {
   if (metrics) metrics.providerLatencyMs += Math.max(0, performance.now() - started);
   await activeWrite;
   await progress(false);
  }
 }
}
