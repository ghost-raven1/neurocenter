import 'reflect-metadata';
import {EventEmitter} from 'node:events';
import type {Request as ExpressRequest,Response as ExpressResponse} from 'express';
import type {McpHostService} from '../src/features/mcp-host/host';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ResearchMcpController} from '../src/features/research-mcp/research-mcp.controller';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {researchFixturePackage,researchFixtureTools} from './research-contract.fixture';
const token='qa-research-internal-only';
const request=()=>new EventEmitter() as EventEmitter&ExpressRequest;
const response=()=>Object.assign(new EventEmitter(),{writableEnded:false}) as EventEmitter&ExpressResponse;

describe('Internal research dispatch, fresh gates and cancellation',()=>{
 let configured:ReturnType<typeof defaultFeatureFlags>,host:{researchTools:ReturnType<typeof vi.fn>;researchCall:ReturnType<typeof vi.fn>;closeResearchSession:ReturnType<typeof vi.fn>},controller:ResearchMcpController;
 let req:ReturnType<typeof request>,res:ReturnType<typeof response>;
 const body=()=>({pkg:researchFixturePackage(),name:'web_search_exa',arguments:{query:'public test query',objective:'verify transport'}});
 beforeEach(()=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);configured=defaultFeatureFlags();
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,options?:RequestInit)=>{options?.signal?.throwIfAborted();return Response.json(evaluateFeatureFlags(configured));}));
  host={researchTools:vi.fn(async()=>researchFixtureTools()),researchCall:vi.fn(async()=>({content:[{type:'text',text:'Public evidence https://example.com/source'}]})),closeResearchSession:vi.fn(async()=>undefined)};
  controller=new ResearchMcpController(host as unknown as McpHostService);req=request();res=response();
 });
 afterEach(()=>{expect(req.listenerCount('aborted')).toBe(0);expect(res.listenerCount('close')).toBe(0);vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
 it.each([undefined,'','wrong','qa-research-internal-evil'])('does not perform package, feature or host work for an unauthorized internal token %#',async supplied=>{
  await expect(controller.list(supplied as string,body(),req,res)).rejects.toMatchObject({status:403});expect(fetch).not.toHaveBeenCalled();expect(host.researchTools).not.toHaveBeenCalled();expect(host.closeResearchSession).not.toHaveBeenCalled();
 });
 it('fails closed if the internal secret itself is missing',async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');await expect(controller.list(token,body(),req,res)).rejects.toMatchObject({status:403});expect(fetch).not.toHaveBeenCalled();});
 it('lists only approved vendor capabilities and closes that request’s private session',async()=>{
  const value=await controller.list(token,body(),req,res);expect(value.tools.map(tool=>tool.name)).toEqual(['web_search_exa','web_fetch_exa']);expect(host.researchCall).not.toHaveBeenCalled();
  const claim=host.researchTools.mock.calls[0][0];expect(claim.researchSessionId).toMatch(/^[a-f0-9-]{36}$/);expect(host.closeResearchSession).toHaveBeenCalledExactlyOnceWith(claim);
 });
 it('validates arguments, rereads current flags after listing, and returns bounded public evidence',async()=>{
  const value=await controller.call(token,body(),req,res);expect(value).toEqual({text:'Public evidence https://example.com/source',sources:[{url:'https://example.com/source'}]});
  expect(fetch).toHaveBeenCalledTimes(2);expect(host.researchCall.mock.calls[0].slice(1,3)).toEqual(['web_search_exa',{query:'public test query',objective:'verify transport',numResults:5}]);
  const signal=host.researchCall.mock.calls[0][3];expect(signal).toBeInstanceOf(AbortSignal);expect(signal.aborted).toBe(false);expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it.each(['research_tools','tool_catalog'] as const)('prevents any host access while %s is disabled',async feature=>{
  configured[feature]=false;await expect(controller.call(token,body(),req,res)).rejects.toMatchObject({status:403,response:{code:'feature-disabled',feature}});expect(host.researchTools).not.toHaveBeenCalled();expect(host.researchCall).not.toHaveBeenCalled();
 });
 it('blocks a paid call when authority is revoked while the vendor tools are being read',async()=>{
  host.researchTools.mockImplementation(async()=>{configured.research_tools=false;return researchFixtureTools();});
  await expect(controller.call(token,body(),req,res)).rejects.toMatchObject({status:403,response:{code:'feature-disabled',feature:'research_tools'}});expect(fetch).toHaveBeenCalledTimes(2);expect(host.researchCall).not.toHaveBeenCalled();expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it('does not replace a completed paid result with a later flag revocation',async()=>{
  host.researchCall.mockImplementation(async()=>{configured.research_tools=false;return {content:[{type:'text',text:'already paid evidence'}]};});expect((await controller.call(token,body(),req,res)).text).toBe('already paid evidence');expect(fetch).toHaveBeenCalledTimes(2);
 });
 it.each([null,[],{}, {pkg:null}])('rejects invalid package framing %# without a child session',async invalid=>{
  await expect(controller.list(token,invalid,req,res)).rejects.toMatchObject({status:400});expect(host.researchTools).not.toHaveBeenCalled();expect(host.closeResearchSession).not.toHaveBeenCalled();
 });
 it('keeps malformed or mutating tool requests away from all vendor operations',async()=>{
  await expect(controller.call(token,{...body(),name:'execute_shell',arguments:{command:'never'}},req,res)).rejects.toMatchObject({status:400});expect(host.researchTools).not.toHaveBeenCalled();expect(host.researchCall).not.toHaveBeenCalled();expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it('rejects a changed vendor schema before call while still closing the private child',async()=>{
  host.researchTools.mockResolvedValue({tools:[]});await expect(controller.call(token,body(),req,res)).rejects.toMatchObject({status:502});expect(host.researchCall).not.toHaveBeenCalled();expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it('maps feature-service failure to a public structured error without exposing private service details',async()=>{
  vi.mocked(fetch).mockResolvedValue(new Response('private upstream failure',{status:503}));await expect(controller.list(token,body(),req,res)).rejects.toMatchObject({status:503,response:{code:'feature-flags-unavailable'}});expect(host.researchTools).not.toHaveBeenCalled();
 });
 it('maps child startup failure to a generic 503 and closes the allocated request session',async()=>{
  host.researchTools.mockRejectedValue(new Error('private endpoint or credential must not reach the caller'));await expect(controller.list(token,body(),req,res)).rejects.toMatchObject({status:503,message:'Поисковый MCP временно недоступен.'});expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it.each(['aborted','close'] as const)('cancels on %s before dispatching an actual vendor call',async event=>{
  host.researchTools.mockImplementation(async(_claim,signal:AbortSignal)=>{(event==='aborted'?req:res).emit(event);signal.throwIfAborted();return researchFixtureTools();});
  await expect(controller.call(token,body(),req,res)).rejects.toMatchObject({status:503,message:'Исследование отменено или превысило время ожидания.'});expect(host.researchCall).not.toHaveBeenCalled();expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it('aborts an in-flight vendor operation and waits for private session cleanup',async()=>{
  let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);let cleaned=false;
  host.closeResearchSession.mockImplementation(async()=>{await Promise.resolve();cleaned=true;});
  host.researchCall.mockImplementation(async(_claim,_name,_args,signal:AbortSignal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();}));
  const operation=controller.call(token,body(),req,res);const rejected=expect(operation).rejects.toMatchObject({status:503});await ready;req.emit('aborted');await rejected;expect(cleaned).toBe(true);expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it('uses the configured 45-second deadline and cleans the session after deadline cancellation',async()=>{
  const expired=new AbortController(),original=AbortSignal.timeout.bind(AbortSignal);const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(milliseconds=>milliseconds===45000?expired.signal:original(milliseconds));
  host.researchCall.mockImplementation(async(_claim,_name,_args,signal:AbortSignal)=>{expired.abort(new Error('Synthetic deadline reached.'));signal.throwIfAborted();});
  await expect(controller.call(token,body(),req,res)).rejects.toMatchObject({status:503,message:'Исследование отменено или превысило время ожидания.'});expect(timeout).toHaveBeenCalledWith(45000);expect(host.closeResearchSession).toHaveBeenCalledOnce();
 });
 it('does not treat closing an already completed response as cancellation',async()=>{
  host.researchTools.mockImplementation(async(_claim,signal:AbortSignal)=>{Object.assign(res,{writableEnded:true});res.emit('close');expect(signal.aborted).toBe(false);return researchFixtureTools();});expect((await controller.list(token,body(),req,res)).tools).toHaveLength(2);
 });
 it('preserves optional compatibility cleanup and reports an explicit cleanup failure safely',async()=>{
  delete (host as any).closeResearchSession;expect((await controller.list(token,body(),req,res)).tools).toHaveLength(2);
  host.closeResearchSession=vi.fn(async()=>{throw new Error('Synthetic private close failure.');});await expect(controller.list(token,body(),req,res)).rejects.toMatchObject({status:503,message:'Поисковый MCP временно недоступен.'});
 });
});
