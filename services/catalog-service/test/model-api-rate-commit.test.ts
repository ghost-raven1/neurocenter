import 'reflect-metadata';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import { ModelRateLimitsService } from '../src/model-rate-limits/model-rate-limits.service';
import { createModelDispatchMetrics, withModelDispatchMetrics } from '../src/model-usage/model-dispatch-metrics';
import { withModelUsage } from '../src/model-usage/model-usage.context';
import type { IModel } from '../src/models/model.types';
import type { ModelsService } from '../src/models/models.service';

const { createPool } = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock('../src/database/pool', () => ({ createPool }));

const model: IModel = { id: 'model-rate-commit', name: 'Commit admission', description: '', runtime: 'remote-openai', capability: 'chat',
 model: 'fixture-model', modelVersion: '1', revision: 1, dimension: null, manifestSha256: null, verificationSha256: 'a'.repeat(64),
 source: 'custom', createdAt: '', updatedAt: '' };
const deferred = <T>() => {
 let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
 const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
 return { promise, resolve, reject };
};

/** Hold only the real repository's COMMIT; destroying its owned client rejects that SQL wait. */
function fixture() {
 const atCommit = deferred<void>(), commit = deferred<void>(), calls: string[] = [];
 const empty = { rows: [], rowCount: 0 };
 const query = vi.fn(async (sql: string) => {
  calls.push(sql);
  if (sql === 'COMMIT') { atCommit.resolve(); await commit.promise; return empty; }
  if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }], rowCount: 1 };
  if (sql.includes('clock_timestamp()::text')) return { rows: [{ instant: '2026-10-25 12:00:00+00' }], rowCount: 1 };
  if (sql.startsWith('SELECT * FROM model_api_rate_limits') || sql.includes('FROM model_api_dispatch_slots')) return empty;
  if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('DELETE FROM model_api_dispatch_slots')) return empty;
  if (sql.startsWith('INSERT INTO model_api_dispatch_slots')) return { rows: [], rowCount: 1 };
  throw new Error('Unexpected rate-store SQL in controlled fixture');
 });
 const release = vi.fn((destroy: boolean) => { if (destroy) commit.reject(new Error('Owned rate client destroyed during COMMIT')); });
 const pool = { connect: vi.fn(async () => ({ query, release })), end: vi.fn(async () => undefined) };
 createPool.mockReturnValue(pool as unknown as Pool);
 const limits = new ModelRateLimitsService({} as ModelsService), gate = new ModelApiAdmission(limits), metrics = createModelDispatchMetrics();
 const send = (provider: () => Promise<string>, beforeInference?: () => Promise<void>, signal?: AbortSignal) => withModelDispatchMetrics(metrics,
  () => withModelUsage({ purpose: 'project-search', projectId: 'prj-rate-commit', beforeInference },
   () => gate.run(model, signal, provider)));
 const close = async (pending: Promise<unknown>) => { commit.resolve(); await pending.catch(() => undefined); await limits.onApplicationShutdown(); };
 return { atCommit, commit, calls, release, pool, metrics, send, close };
}

function expectOneOwnedSlot(f: ReturnType<typeof fixture>) {
 expect(f.pool.connect).toHaveBeenCalledOnce();
 expect(f.calls.filter(sql => sql.startsWith('INSERT INTO model_api_dispatch_slots'))).toHaveLength(1);
 expect(f.calls.filter(sql => sql === 'COMMIT')).toHaveLength(1);
 expect(f.release).toHaveBeenCalledOnce();
}

let flags = defaultFeatureFlags();
beforeEach(() => {
 createPool.mockReset(); flags = defaultFeatureFlags();
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evaluateFeatureFlags(flags)), { status: 200 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Fresh provider authority after the real rate COMMIT without a dispatch-only guard', () => {
 it('blocks project search disabled while COMMIT is held before any provider dispatch', async () => {
  const f = fixture(), provider = vi.fn(async () => 'answer'), pending = f.send(provider), result = pending.catch(error => error);
  try {
   await f.atCommit.promise;
   expect(flags.project_search).toBe(true); expect(provider).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
   flags.project_search = false; f.commit.resolve();
   const error = await result;
   expect(error).toBeInstanceOf(ForbiddenException);
   expect(error.getResponse()).toMatchObject({ code: 'feature-disabled', feature: 'project_search' });
   expect(provider).not.toHaveBeenCalled(); expect(f.metrics.dispatchCount).toBe(0); expect(f.metrics.dispatchedAt).toBeNull();
   expectOneOwnedSlot(f);
  } finally { await f.close(pending); }
 });

 it.each([
  { authority: 'project ACL', code: 'PROJECT_ACCESS_REVOKED' },
  { authority: 'project model binding', code: 'MODEL_BINDING_REVOKED' },
 ])('preserves a fresh $authority refusal after COMMIT without calling the provider', async ({ code }) => {
  let allowed = true;
  const refusal = new ForbiddenException({ code, message: 'Project inference authority revoked' });
  const beforeInference = vi.fn(async () => { if (!allowed) throw refusal; });
  const f = fixture(), provider = vi.fn(async () => 'answer'), pending = f.send(provider, beforeInference), result = pending.catch(error => error);
  try {
   await f.atCommit.promise;
   expect(beforeInference).toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
   allowed = false; f.commit.resolve();
   expect(await result).toBe(refusal);
   expect(provider).not.toHaveBeenCalled(); expect(f.metrics.dispatchCount).toBe(0); expect(f.metrics.dispatchedAt).toBeNull();
   expectOneOwnedSlot(f);
  } finally { await f.close(pending); }
 });

 it('dispatches once when feature, ACL and model binding remain current across COMMIT', async () => {
  const beforeInference = vi.fn(async () => undefined), f = fixture(), provider = vi.fn(async () => 'answer'), pending = f.send(provider, beforeInference);
  try {
   await f.atCommit.promise;
   expect(beforeInference).toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
   f.commit.resolve(); await expect(pending).resolves.toBe('answer');
   expect(provider).toHaveBeenCalledOnce(); expect(f.metrics).toMatchObject({ dispatchCount: 1, dispatchedAt: expect.any(String) });
   expectOneOwnedSlot(f);
  } finally { await f.close(pending); }
 });
});

describe('Cancellation and an unknown rate COMMIT retain their original ownership', () => {
 it('interrupts the held COMMIT through release(true), preserves caller abort and never dispatches', async () => {
  const f = fixture(), abort = new AbortController(), reason = new Error('Caller cancelled during rate COMMIT');
  const provider = vi.fn(async () => 'answer'), pending = f.send(provider, undefined, abort.signal), result = pending.catch(error => error);
  try {
   await f.atCommit.promise; abort.abort(reason);
   // No manual COMMIT acknowledgement: the real cancellation owner must settle the pending operation.
   expect(await result).toBe(reason);
   expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expectOneOwnedSlot(f);
   expect(provider).not.toHaveBeenCalled(); expect(f.metrics.dispatchCount).toBe(0); expect(f.metrics.dispatchedAt).toBeNull();
   expect(f.calls).not.toContain('ROLLBACK');
  } finally { await f.close(pending); }
 });

 it('returns the actual service 503 for an unknown COMMIT without retrying its slot or provider', async () => {
  const f = fixture(), provider = vi.fn(async () => 'answer'), pending = f.send(provider), result = pending.catch(error => error);
  try {
   await f.atCommit.promise; f.commit.reject(new Error('COMMIT acknowledgement lost'));
   const error = await result;
   expect(error).toBeInstanceOf(ServiceUnavailableException); expect(error.getStatus()).toBe(503);
   expect(error.getResponse()).toMatchObject({ code: 'MODEL_RATE_STORE_UNAVAILABLE' });
   expect(provider).not.toHaveBeenCalled(); expect(f.metrics.dispatchCount).toBe(0); expect(f.metrics.dispatchedAt).toBeNull();
   expectOneOwnedSlot(f);
  } finally { await f.close(pending); }
 });
});

describe('An already accepted provider result survives later feature changes', () => {
 it('retains the paid result when project search is disabled after provider entry', async () => {
  const f = fixture(), atProvider = deferred<void>(), response = deferred<string>();
  const provider = vi.fn(async () => { atProvider.resolve(); return response.promise; }), pending = f.send(provider);
  try {
   await f.atCommit.promise; f.commit.resolve(); await atProvider.promise;
   flags.project_search = false; response.resolve('accepted answer');
   await expect(pending).resolves.toBe('accepted answer');
   expect(provider).toHaveBeenCalledOnce(); expect(f.metrics.dispatchCount).toBe(1); expectOneOwnedSlot(f);
  } finally { response.resolve('accepted answer'); await f.close(pending); }
 });
});
