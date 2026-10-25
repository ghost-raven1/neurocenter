import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { ModelApiAdmission } from '../src/model-api-admission/model-api-admission';
import type { ModelRateLimitsService } from '../src/model-rate-limits/model-rate-limits.service';
import { OllamaClient } from '../src/models/ollama-client';
import { RemoteModelClient } from '../src/models/remote-model-client';
import { localModelAlias } from '../src/models/local-model-alias';
import type { IModel } from '../src/models/model.types';
import { withModelUsage } from '../src/model-usage/model-usage.context';
import {createModelDispatchMetrics,withModelDispatchMetrics} from '../src/model-usage/model-dispatch-metrics';

const local: IModel = { id: 'model-transport', name: 'Transport', description: '', runtime: 'ollama', capability: 'chat', model: 'fixture:v1',
 revision: 1, dimension: null, manifestSha256: 'a'.repeat(64), source: 'custom', createdAt: '', updatedAt: '' };
const remote: IModel = { ...local, runtime: 'remote-openai', modelVersion: '1', model: 'provider-model', manifestSha256: null };
const messages = [{ role: 'user', content: 'Question' }];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
let flags = defaultFeatureFlags();
beforeEach(() => { flags = defaultFeatureFlags(); vi.stubGlobal('fetch', vi.fn(async () => json(evaluateFeatureFlags(flags)))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Gate on the physical provider boundary', () => {
 it('runs the dispatch-only guard after a held rate permit and never sends an obsolete planning request',async()=>{
  let release!:()=>void,entered!:()=>void,available=true;const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const provider=vi.fn(async()=> 'answer'),guard=vi.fn(async()=>{if(!available)throw new Error('planning unavailable');}),metrics=createModelDispatchMetrics();
  const acquire:ModelRateLimitsService['acquire']=async(_model,_signal,beforeAttempt)=>{await beforeAttempt?.();entered();await held;};
  const gate=new ModelApiAdmission({acquire}as never);
  const pending=withModelDispatchMetrics(metrics,()=>withModelUsage({purpose:'direct',beforeDispatch:guard},()=>gate.run(local,undefined,provider)));
  const rejected=pending.catch(error=>error);await started;available=false;release();expect(await rejected).toMatchObject({message:'planning unavailable'});
  expect(guard).toHaveBeenCalledOnce();expect(provider).not.toHaveBeenCalled();expect(metrics.dispatchCount).toBe(0);
 });
 it('does not recheck a dispatch-only guard after the provider has accepted the request',async()=>{
  let available=true;const guard=vi.fn(async()=>{if(!available)throw new Error('planning unavailable');});
  const gate=new ModelApiAdmission({acquire:async()=>undefined}as never),provider=vi.fn(async()=>{available=false;return 'received answer';});
  expect(await withModelUsage({purpose:'direct',beforeDispatch:guard},()=>gate.run(local,undefined,provider))).toBe('received answer');
  expect(provider).toHaveBeenCalledOnce();expect(guard).toHaveBeenCalledOnce();
 });
 it('cannot send a late provider request when cancellation occurs during its dispatch-only guard',async()=>{
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),abort=new AbortController();
  const provider=vi.fn(),gate=new ModelApiAdmission({acquire:async()=>undefined}as never);
  const pending=withModelUsage({purpose:'direct',beforeDispatch:async()=>{entered();await held;}},()=>gate.run(local,abort.signal,provider));
  const rejected=pending.catch(error=>error);await started;abort.abort(new Error('cancelled'));release();expect(await rejected).toBe(abort.signal.reason);expect(provider).not.toHaveBeenCalled();
 });
 it('rechecks ordinary authority after a dispatch-only guard has waited',async()=>{
  let current=true;const provider=vi.fn(),gate=new ModelApiAdmission({acquire:async()=>undefined}as never);
  await expect(withModelUsage({purpose:'direct',beforeInference:async()=>{if(!current)throw new Error('source revoked');},beforeDispatch:async()=>{current=false;}},()=>gate.run(local,undefined,provider))).rejects.toThrow('source revoked');
  expect(provider).not.toHaveBeenCalled();
 });
 it('records active metadata after transport starts and orders settlement after a held active write',async()=>{
  let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),observed=new Promise<void>(resolve=>{entered=resolve;});
  const events:string[]=[],metrics=createModelDispatchMetrics();
  metrics.progress=async active=>{events.push(active?'active-start':'settled');if(active){entered();await hold;events.push('active-saved');}};
  const gate=new ModelApiAdmission({acquire:async()=>undefined} as unknown as ModelRateLimitsService);
  const result=withModelDispatchMetrics(metrics,()=>gate.run(local,undefined,async()=>{events.push('provider');return 'answer';}));
  await observed;expect(events).toEqual(['provider','active-start']);release();await expect(result).resolves.toBe('answer');
  expect(events).toEqual(['provider','active-start','active-saved','settled']);expect(metrics.dispatchCount).toBe(1);
 });
 it('does not advertise active inference when admission is cancelled before transport',async()=>{
  const abort=new AbortController(),metrics=createModelDispatchMetrics();metrics.progress=vi.fn();
  const gate=new ModelApiAdmission({acquire:async()=>{abort.abort();abort.signal.throwIfAborted();}} as unknown as ModelRateLimitsService),provider=vi.fn();
  await expect(withModelDispatchMetrics(metrics,()=>gate.run(local,abort.signal,provider))).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled();expect(metrics.progress).not.toHaveBeenCalled();expect(metrics.dispatchCount).toBe(0);
 });
 const limiter = () => {
  const acquire = vi.fn(async (_model: IModel, signal: AbortSignal | undefined, fresh: () => Promise<boolean | void>) => { signal?.throwIfAborted(); await fresh(); });
  return { acquire, gate: new ModelApiAdmission({ acquire } as unknown as ModelRateLimitsService) };
 };
 it.each(['remote-openai', 'remote-ollama'] as const)('counts a %s chat after payload validation and before fetch exactly once', async runtime => {
  const { acquire, gate } = limiter(), model = { ...remote, runtime };
  const provider = vi.fn(async () => {
   expect(acquire).toHaveBeenCalledOnce(); return json(runtime === 'remote-openai'
    ? { model: model.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer' } }] }
    : { model: model.model, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Answer' } });
  });
  const client = new RemoteModelClient({ fetch: provider, admission: gate });
  await expect(client.infer(model, { modelId: model.id, revision: 1, baseUrl: 'https://provider.example.test/v1', requestDimensions: false }, 'chat', { messages })).resolves.toMatchObject({ message: { content: 'Answer' } });
  expect(acquire.mock.calls[0][0].id).toBe(local.id); expect(provider).toHaveBeenCalledOnce();
 });
 it('uses the same catalog identity for remote embedding calls', async () => {
  const { acquire, gate } = limiter(), model = { ...remote, capability: 'embedding' as const, dimension: 2 };
  const provider = vi.fn(async () => json({ model: model.model, object: 'list', data: [{ index: 0, object: 'embedding', embedding: [0.5, 0.25] }] }));
  await new RemoteModelClient({ fetch: provider, admission: gate }).infer(model, { modelId: model.id, revision: 1, baseUrl: 'https://provider.example.test/v1', requestDimensions: false }, 'embed', { input: ['text'] });
  expect(acquire).toHaveBeenCalledOnce(); expect(acquire.mock.calls[0][0].id).toBe(model.id); expect(provider).toHaveBeenCalledOnce();
 });
 it('does not consume a permit for a malformed payload', async () => {
  const { acquire, gate } = limiter(), provider = vi.fn();
  await expect(new RemoteModelClient({ fetch: provider, admission: gate }).infer(remote, { modelId: remote.id, revision: 1, baseUrl: 'https://provider.example.test/v1', requestDimensions: false }, 'chat', { messages: [] })).rejects.toThrow();
  expect(acquire).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
 });
 it('checks fresh flags after local metadata preflight before sending chat', async () => {
  const { acquire, gate } = limiter(), alias = localModelAlias(local), paths: string[] = [];
  const provider = vi.fn(async (input: string | URL | Request) => {
   const path = new URL(String(input)).pathname; paths.push(path);
   if (path === '/api/tags') { flags.model_hosting = false; return json({ models: [{ name: alias, digest: local.manifestSha256 }] }); }
   throw new Error('A forbidden physical chat request escaped the gate');
  });
  await expect(new OllamaClient({ fetch: provider, admission: gate }).infer(local, 'chat', { messages })).rejects.toMatchObject({ status: 403 });
  expect(paths).toEqual(['/api/tags']); expect(acquire).not.toHaveBeenCalled();
 });
 it('counts local chat once after tags, while retaining catalog ID rather than private runtime tag', async () => {
  const { acquire, gate } = limiter(), alias = localModelAlias(local), paths: string[] = [];
  const provider = vi.fn(async (input: string | URL | Request) => {
   const path = new URL(String(input)).pathname; paths.push(path);
   if (path === '/api/tags') { expect(acquire).not.toHaveBeenCalled(); return json({ models: [{ name: alias, digest: local.manifestSha256 }] }); }
   expect(acquire).toHaveBeenCalledOnce(); return json({ model: alias, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Answer' } });
  });
  const result = await new OllamaClient({ fetch: provider, admission: gate }).infer(local, 'chat', { messages });
  expect(result.model).toBe(local.model); expect(paths).toEqual(['/api/tags', '/api/chat']); expect(acquire.mock.calls[0][0].id).toBe(local.id);
 });
 it('rates a local semantic verification probe but exempts its metadata requests', async () => {
  const { acquire, gate } = limiter(), alias = localModelAlias(local), paths: string[] = [];
  const provider = vi.fn(async (input: string | URL | Request) => {
   const path = new URL(String(input)).pathname; paths.push(path);
   if (path === '/api/tags') return json({ models: [{ name: alias, digest: local.manifestSha256 }] });
   if (path === '/api/show') return json({ capabilities: ['completion'] });
   expect(acquire).toHaveBeenCalledOnce(); return json({ model: alias, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'OK' } });
  });
  await withModelUsage({ purpose: 'verification', actorEmail: 'admin@example.test' }, () => new OllamaClient({ fetch: provider, admission: gate }).check(local));
  expect(paths).toEqual(['/api/tags', '/api/show', '/api/chat', '/api/tags']); expect(acquire).toHaveBeenCalledOnce();
 });
 it('preserves unload recovery while model rate and hosting feature flags are off', async () => {
  flags.model_rate_limits = false; flags.model_hosting = false;
  const { acquire, gate } = limiter(), alias = localModelAlias(local), paths: string[] = [];
  const provider = vi.fn(async (input: string | URL | Request) => {
   const path = new URL(String(input)).pathname; paths.push(path);
   if (path === '/api/tags') return json({ models: [{ name: alias, digest: local.manifestSha256 }] });
   if (path === '/api/ps') return json({ models: [] });
   return json({ model: alias, done: true, done_reason: 'unload' });
  });
  await new OllamaClient({ fetch: provider, admission: gate }).stop(local);
  expect(paths).toEqual(['/api/tags', '/api/chat', '/api/ps']); expect(acquire).not.toHaveBeenCalled();
 });
 it('preserves a structured admission failure without sanitizing it into a remote transport failure', async () => {
  const action = vi.fn(), admission = { run: vi.fn(async () => { throw Object.assign(new Error('Limit wait timed out'), { status: 429, code: 'MODEL_RATE_WAIT_TIMEOUT' }); }) };
  await expect(new RemoteModelClient({ fetch: action, admission }).infer(remote, { modelId: remote.id, revision: 1, baseUrl: 'https://provider.example.test/v1', requestDimensions: false }, 'chat', { messages })).rejects.toMatchObject({ status: 429, code: 'MODEL_RATE_WAIT_TIMEOUT' });
  expect(action).not.toHaveBeenCalled(); expect(admission.run).toHaveBeenCalledOnce();
 });
});
