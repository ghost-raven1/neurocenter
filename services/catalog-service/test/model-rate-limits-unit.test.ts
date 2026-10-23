import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import { ModelRateLimitsRepository } from '../src/model-rate-limits/model-rate-limits.repository';
import { modelRateLimitInput } from '../src/model-rate-limits/model-rate-limits.validation';
import { ModelRateLimitsService } from '../src/model-rate-limits/model-rate-limits.service';
import { createModelDispatchMetrics, withModelDispatchMetrics } from '../src/model-usage/model-dispatch-metrics';
import { withModelUsage } from '../src/model-usage/model-usage.context';
import type { IModel } from '../src/models/model.types';

const model: IModel = { id: 'model-rate', name: 'Rate', description: '', runtime: 'remote-openai', capability: 'chat', model: 'test-model', modelVersion: '1',
 revision: 1, dimension: null, manifestSha256: null, verificationSha256: 'a'.repeat(64), source: 'custom', createdAt: '', updatedAt: '' };
let flags = defaultFeatureFlags();
beforeEach(() => { flags = defaultFeatureFlags(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 }))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Rate policy validation', () => {
 const input = { expectedRevision: 0, requests: 5, windowMs: 5000, enabled: true };
 it('accepts virtual defaults and both exact supported boundaries', () => {
  expect(modelRateLimitInput(input)).toEqual(input);
  expect(modelRateLimitInput({ ...input, requests: 1, windowMs: 1000 })).toMatchObject({ requests: 1, windowMs: 1000 });
  expect(modelRateLimitInput({ ...input, requests: 1000, windowMs: 86400000 })).toMatchObject({ requests: 1000, windowMs: 86400000 });
 });
 it.each([{ requests: 0 }, { requests: 1001 }, { requests: 1.5 }, { requests: '5' }, { windowMs: 999 }, { windowMs: 86400001 },
  { expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { enabled: 'true' }, { expectedModelPin: 'private' }])('rejects unsupported policy %j', invalid => {
  expect(() => modelRateLimitInput({ ...input, ...invalid })).toThrow();
 });
});

describe('Atomic admission ordering and ambiguous results', () => {
 const fixture = (override?: (sql: string) => unknown) => {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
   calls.push(sql); const result = override?.(sql); if (result instanceof Error) throw result; if (result) return result;
   if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
   if (sql.includes('clock_timestamp')) return { rows: [{ instant: '2026-10-23 12:00:00+00' }] };
   return { rows: [], rowCount: 0 };
  });
  const release = vi.fn(), pool = { connect: vi.fn(async () => { calls.push('checkout'); return { query, release }; }) };
  return { repository: new ModelRateLimitsRepository(pool as unknown as Pool), calls, query, release, pool };
 };
 it('authorizes after checkout before BEGIN and obtains the database clock after the per-model lock', async () => {
  const f = fixture();
  expect(await f.repository.tryAcquire(model.id, undefined, async () => { f.calls.push('fresh authorization'); })).toEqual({ admitted: true, retryAfterMs: 0 });
  expect(f.calls.slice(0, 3)).toEqual(['checkout', 'fresh authorization', 'BEGIN']);
  expect(f.calls.findIndex(sql => sql.includes('clock_timestamp'))).toBeGreaterThan(f.calls.findIndex(sql => sql.includes('pg_try_advisory')));
  expect(f.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1); expect(f.calls.at(-1)).toBe('COMMIT'); expect(f.release).toHaveBeenCalledOnce();
 });
 it('does not keep a transaction or insert a slot when its nonblocking lock is held elsewhere', async () => {
  const f = fixture(sql => sql.includes('pg_try_advisory') ? { rows: [{ locked: false }] } : undefined);
  expect(await f.repository.tryAcquire(model.id)).toEqual({ admitted: false, retryAfterMs: 15 });
  expect(f.calls.at(-1)).toBe('ROLLBACK'); expect(f.calls.some(sql => sql.startsWith('INSERT'))).toBe(false); expect(f.release).toHaveBeenCalledOnce();
 });
 it('rechecks cancellation after lock acquisition and never consumes an aborted slot', async () => {
  const abort = new AbortController(), f = fixture(sql => { if (sql.includes('pg_try_advisory')) abort.abort(new Error('cancelled while SQL waited')); });
  const error = await f.repository.tryAcquire(model.id, abort.signal).catch(error => error);
  expect(error).toBe(abort.signal.reason);
  expect(f.calls.some(sql => sql.startsWith('INSERT'))).toBe(false); expect(f.calls).not.toContain('COMMIT'); expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
 });
 it('retains an unknown commit outcome without retrying the insert or claiming admission', async () => {
  const f = fixture(sql => sql === 'COMMIT' ? new Error('connection lost after COMMIT') : undefined);
  await expect(f.repository.tryAcquire(model.id)).rejects.toThrow('connection lost after COMMIT');
  expect(f.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1); expect(f.calls.filter(sql => sql === 'COMMIT')).toHaveLength(1); expect(f.release).toHaveBeenCalledOnce();
 });
 it('does not begin a transaction when the global feature changed to OFF after checkout', async () => {
  const f = fixture(); expect(await f.repository.tryAcquire(model.id, undefined, async () => false)).toEqual({ admitted: true, retryAfterMs: 0 });
  expect(f.query).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
 });
 it('releases its rate client on cancellation while a fresh SQL authorization is still pending', async () => {
  let started!: () => void, complete!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { complete = resolve; });
  const f = fixture(), abort = new AbortController();
  const pending = f.repository.tryAcquire(model.id, abort.signal, async () => { started(); await held; });
  const rejected = pending.catch(error => error); await entered; abort.abort(new Error('cancelled during authorization'));
  expect(await rejected).toBe(abort.signal.reason); expect(f.release).toHaveBeenCalledOnce(); expect(f.query).not.toHaveBeenCalled();
  complete(); await held; await Promise.resolve();
  expect(f.query).not.toHaveBeenCalled();
 });
 it('destroys only its owned rate client to interrupt a SQL lock wait after BEGIN', async () => {
  let entered!: () => void, rejectQuery!: (reason: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), calls: string[] = [], abort = new AbortController();
  const query = vi.fn(async (sql: string) => {
   calls.push(sql);
   if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
   if (sql.includes('clock_timestamp')) return { rows: [{ instant: '2026-10-23 12:00:00+00' }] };
   if (sql.startsWith('DELETE')) { entered(); return await new Promise((_resolve, reject) => { rejectQuery = reject; }); }
   return { rows: [] };
  });
  const release = vi.fn((destroy: boolean) => { if (destroy) rejectQuery(new Error('owned connection destroyed')); });
  const pool = { connect: vi.fn(async () => ({ query, release })) };
  const repository = new ModelRateLimitsRepository(pool as unknown as Pool), pending = repository.tryAcquire(model.id, abort.signal), result = pending.catch(error => error);
  await started; abort.abort(new Error('cancel SQL wait'));
  expect(await result).toBe(abort.signal.reason); expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect(pool.connect).toHaveBeenCalledOnce(); expect(calls.some(sql => sql.startsWith('INSERT'))).toBe(false); expect(calls).not.toContain('COMMIT');
 });
 it('cancels a pending checkout and returns its late client unused without waiting for the pool', async () => {
  let started!: () => void, deliver!: (db: unknown) => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), held = new Promise(resolve => { deliver = resolve; });
  const pool = { connect: vi.fn(async () => { started(); return await held; }) }, repository = new ModelRateLimitsRepository(pool as unknown as Pool);
  let returned!: () => void;const returnedClient = new Promise<void>(resolve => { returned = resolve; });
  const abort = new AbortController(), query = vi.fn(), release = vi.fn(() => returned()), pending = repository.tryAcquire(model.id, abort.signal), result = pending.catch(error => error);
  await entered; abort.abort(new Error('cancelled checkout')); expect(await result).toBe(abort.signal.reason);
  expect(release).not.toHaveBeenCalled(); deliver({ query, release }); await returnedClient;
  expect(release).toHaveBeenCalledExactlyOnceWith(); expect(query).not.toHaveBeenCalled();
 });
 it('interrupts a settings row lock with its own signal and preserves the old policy', async () => {
  let entered!: () => void, rejectQuery!: (reason: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), abort = new AbortController(), calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
   calls.push(sql); if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
   if (sql.includes('FROM model_catalog')) { entered(); return await new Promise((_resolve, reject) => { rejectQuery = reject; }); }
   return { rows: [] };
  });
  const release = vi.fn((destroy: boolean) => { if (destroy) rejectQuery(new Error('closed owned settings client')); });
  const repository = new ModelRateLimitsRepository({ connect: vi.fn(async () => ({ query, release })) } as unknown as Pool);
  const pending = repository.trySave(model.id, { expectedRevision: 0, requests: 5, windowMs: 5000, enabled: true }, 'admin@example.test', async () => undefined, abort.signal), result = pending.catch(error => error);
  await started; abort.abort(new Error('cancel settings wait'));
  expect(await result).toBe(abort.signal.reason); expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect(calls.some(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE'))).toBe(false); expect(calls).not.toContain('COMMIT');
 });
});

describe('Actual transport admission and telemetry', () => {
 it('bypasses the rate pool while OFF but still records the actual provider dispatch', async () => {
  flags.model_rate_limits = false;
  const acquire = vi.fn(async () => { throw new Error('store is offline'); }), gate = new ModelApiAdmission({ acquire } as unknown as ModelRateLimitsService);
  const action = vi.fn(async () => 'result'), beforeInference = vi.fn(async () => undefined), metrics = createModelDispatchMetrics();
  expect(await withModelDispatchMetrics(metrics, () => withModelUsage({ purpose: 'chat', beforeInference }, () => gate.run(model, undefined, action)))).toBe('result');
  expect(acquire).not.toHaveBeenCalled(); expect(action).toHaveBeenCalledOnce(); expect(beforeInference).toHaveBeenCalledOnce();
  expect(metrics).toMatchObject({ dispatchCount: 1, rateWaitMs: 0, dispatchedAt: expect.any(String) }); expect(metrics.providerLatencyMs).toBeGreaterThanOrEqual(0);
 });
 it('revalidates the current job after a rate wait and preserves a cancellation/conflict before physical fetch', async () => {
  let authorized = true;
  const acquire = vi.fn(async (_model, _signal, beforeAttempt) => { authorized = false; await beforeAttempt(); });
  const gate = new ModelApiAdmission({ acquire } as unknown as ModelRateLimitsService), action = vi.fn(async () => 'unexpected');
  const beforeInference = async () => { if (!authorized) throw new ForbiddenException('Role revoked'); };
  await expect(withModelUsage({ purpose: 'chat', beforeInference }, () => gate.run(model, undefined, action))).rejects.toMatchObject({ status: 403 });
  expect(action).not.toHaveBeenCalled();
 });
 it('blocks a new provider call when its feature is disabled while waiting', async () => {
  const acquire = vi.fn(async (_model, _signal, beforeAttempt) => { flags.group_chat = false; await beforeAttempt(); });
  const gate = new ModelApiAdmission({ acquire } as unknown as ModelRateLimitsService), action = vi.fn(async () => 'unexpected'), metrics = createModelDispatchMetrics();
  await expect(withModelDispatchMetrics(metrics, () => withModelUsage({ purpose: 'agent', agentId: 'agent-one' }, () => gate.run(model, undefined, action)))).rejects.toMatchObject({ status: 403 });
  expect(action).not.toHaveBeenCalled(); expect(metrics.dispatchCount).toBe(0); expect(metrics.dispatchedAt).toBeNull();
 });
 it('records one actual dispatch, its wait, and provider duration even if the provider fails', async () => {
  const acquire = vi.fn(async (_model, _signal, beforeAttempt, onWait) => { onWait(125); await beforeAttempt(); }), gate = new ModelApiAdmission({ acquire } as unknown as ModelRateLimitsService);
  const action = vi.fn(async () => { throw new Error('provider failed'); }), metrics = createModelDispatchMetrics();
  await expect(withModelDispatchMetrics(metrics, () => gate.run(model, undefined, action))).rejects.toThrow('provider failed');
  expect(action).toHaveBeenCalledOnce(); expect(metrics).toMatchObject({ dispatchCount: 1, rateWaitMs: 125, dispatchedAt: expect.any(String) });
 });
 it('never repeats a provider request after an unknown admission result', async () => {
  const acquire = vi.fn(async () => { throw new Error('unknown COMMIT'); }), action = vi.fn(async () => 'unexpected'), gate = new ModelApiAdmission({ acquire } as unknown as ModelRateLimitsService);
  await expect(gate.run(model, undefined, action)).rejects.toThrow('unknown COMMIT'); expect(action).not.toHaveBeenCalled(); expect(acquire).toHaveBeenCalledOnce();
 });
 it('starts the enabled rate budget before a potentially slow authorization and retains the first dispatch timestamp', async () => {
  const beforeInference = vi.fn(async () => undefined), metrics = createModelDispatchMetrics(); metrics.dispatchedAt = '2026-10-23T10:00:00.000Z';
  const acquire = vi.fn(async (_model, _signal, beforeAttempt) => { expect(beforeInference).not.toHaveBeenCalled(); await beforeAttempt(); });
  const gate = new ModelApiAdmission({ acquire } as unknown as ModelRateLimitsService);
  await withModelDispatchMetrics(metrics, () => withModelUsage({ purpose: 'chat', beforeInference }, () => gate.run(model, undefined, async () => 'answer')));
  expect(beforeInference).toHaveBeenCalledOnce(); expect(metrics.dispatchCount).toBe(1); expect(metrics.dispatchedAt).toBe('2026-10-23T10:00:00.000Z');
 });
});

describe('Unknown settings acknowledgement', () => {
 it('returns a reconcile-first error after an unknown save result and never repeats the policy write', async () => {
  const write = vi.fn(async (..._args: unknown[]) => { throw new Error('COMMIT acknowledgement lost'); }), service = Object.create(ModelRateLimitsService.prototype) as ModelRateLimitsService;
  Object.assign(service, { models: { requireMain: vi.fn(async () => 'admin@example.test') }, shutdown: new AbortController(), repository: { trySave: write } });
  const error = await service.save({} as never, model.id, { expectedRevision: 0, requests: 5, windowMs: 5000, enabled: true }).catch(error => error);
  expect(error.getStatus()).toBe(503); expect(error.getResponse()).toMatchObject({ code: 'MODEL_RATE_POLICY_SAVE_UNCONFIRMED' });
  expect(write).toHaveBeenCalledOnce(); expect(write.mock.calls[0][4]).toBeInstanceOf(AbortSignal);
 });
});
