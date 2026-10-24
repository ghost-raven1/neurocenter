import 'reflect-metadata';
import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request as ExpressRequest,Response as ExpressResponse} from 'express';
import {buildPackage} from '../../catalog-service/src/catalog/bundle-package';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {normalizeRoleMcpTool} from '../../shared/system-role-mcp.cjs';
import {hostRuntimeTarget} from '../src/features/mcp-host/host-target';
import {SystemRoleMcpGatewayController} from '../src/features/system-role-mcp/system-role-mcp.controller';
const token='qa-system-role-internal-token',id='00000000-0000-0000-0000-000000000001',sessionId='00000000-0000-0000-0000-000000000002',proof='d'.repeat(64);
const tool=normalizeRoleMcpTool({name:'browser_navigate',description:'Selected browser capability',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}});
const pkg=()=>buildPackage({id:'browser',kind:'mcp',name:'Browser',version:1},[],'2026-10-25',{transport:'stdio',args:[],extra:{hostedMcp:true,runtimeArtifacts:[{
 target:hostRuntimeTarget(),sha256:'a'.repeat(64),entrypoint:'runtime/server.mjs',compressedBytes:100,unpackedBytes:200,filesCount:1}]}});
const request=()=>new EventEmitter()as EventEmitter&ExpressRequest;
const response=()=>Object.assign(new EventEmitter(),{writableEnded:false})as EventEmitter&ExpressResponse;
describe('system role gateway uses the approved generic host and one-send catalogue boundary',()=>{
 let flags:ReturnType<typeof defaultFeatureFlags>,host:{operationTools:ReturnType<typeof vi.fn>;operationCall:ReturnType<typeof vi.fn>;closeOperationSession:ReturnType<typeof vi.fn>};
 let context:any,controller:SystemRoleMcpGatewayController,dispatchFailed:boolean,req:ReturnType<typeof request>,res:ReturnType<typeof response>,dispatches:number,receipts:unknown[],loseReceiptAck:boolean;
 beforeEach(()=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);flags=defaultFeatureFlags();dispatchFailed=false;dispatches=0;receipts=[];loseReceiptAck=false;req=request();res=response();
  context={session:{sessionId,jobId:null,projectId:'project',target:{runtime:'server',assetId:'browser',version:1,manifest:pkg().manifest.sha256},package:pkg(),deadlineAt:new Date(Date.now()+120000).toISOString()},
   call:{id,proof,kind:'call',name:tool.name,schemaDigest:tool.schemaDigest,arguments:{url:'https://fixture.example/page'},deadlineAt:new Date(Date.now()+45000).toISOString()}};
  host={operationTools:vi.fn(async()=>({tools:[tool]})),operationCall:vi.fn(async()=>({content:[{type:'text',text:'Page loaded'}]})),closeOperationSession:vi.fn(async()=>{})};
  vi.stubGlobal('fetch',vi.fn(async(url:unknown,options?:RequestInit)=>{
   options?.signal?.throwIfAborted();const route=String(url);
   if(route.endsWith('/internal/system-role-mcp/context'))return Response.json(context);
   if(route.endsWith('/internal/system-role-mcp/dispatch')){dispatches++;if(dispatchFailed)throw new Error('ACK lost');return Response.json({ok:true});}
   if(route.endsWith('/internal/system-role-mcp/result')){receipts.push(JSON.parse(String(options?.body)));if(loseReceiptAck){loseReceiptAck=false;throw new Error('Receipt ACK lost');}return Response.json({ok:true});}
   return Response.json(evaluateFeatureFlags(flags));
  }));controller=new SystemRoleMcpGatewayController(host as never);
 });
 afterEach(()=>{expect(req.listenerCount('aborted')).toBe(0);expect(res.listenerCount('close')).toBe(0);vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
 it('rejects an unauthorized token before reading private context or starting a host',async()=>{
  await expect(controller.execute('wrong',{callId:id},req,res)).rejects.toMatchObject({status:403});expect(fetch).not.toHaveBeenCalled();expect(host.operationTools).not.toHaveBeenCalled();
 });
 it('executes an explicitly selected browser tool without substituting research search',async()=>{
  expect(await controller.execute(token,{callId:id},req,res)).toEqual({state:'succeeded',value:{text:'Page loaded',isError:false,truncated:false}});
  expect(host.operationCall.mock.calls[0].slice(1,3)).toEqual(['browser_navigate',{url:'https://fixture.example/page'}]);
  expect(host.operationCall.mock.calls[0][0].operationSessionId).toBe(sessionId);expect(dispatches).toBe(1);expect(host.closeOperationSession).not.toHaveBeenCalled();
 });
 it.each(['schema','input'])('keeps changed %s away from the actual tool boundary',async issue=>{
  if(issue==='schema')context.call.schemaDigest='b'.repeat(64);else context.call.arguments={url:42};
  expect(await controller.execute(token,{callId:id},req,res)).toMatchObject({state:'failed'});expect(dispatches).toBe(0);expect(host.operationCall).not.toHaveBeenCalled();expect(host.closeOperationSession).toHaveBeenCalledOnce();
 });
 it('does not send or replay a tool when its one-send dispatch acknowledgement is lost',async()=>{
  dispatchFailed=true;expect(await controller.execute(token,{callId:id},req,res)).toMatchObject({state:'unknown'});
  expect(dispatches).toBe(1);expect(host.operationCall).not.toHaveBeenCalled();expect(host.closeOperationSession).toHaveBeenCalledOnce();
 });
 it('checks new-work flags again after actual discovery and keeps completed results after later flag-off',async()=>{
  host.operationTools.mockImplementationOnce(async()=>{flags.system_role_mcp=false;return {tools:[tool]};});
  expect(await controller.execute(token,{callId:id},req,res)).toMatchObject({state:'failed'});expect(dispatches).toBe(0);
  flags.system_role_mcp=true;host.operationCall.mockImplementationOnce(async()=>{flags.system_role_mcp=false;return {content:[{type:'text',text:'Completed before flag change'}]};});
  expect(await controller.execute(token,{callId:id},req,res)).toMatchObject({state:'succeeded',value:{text:'Completed before flag change'}});
 });
 it('cancels and closes an owned in-flight session without claiming the external outcome',async()=>{
  let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
  host.operationCall.mockImplementation(async(_claim,_name,_args,signal:AbortSignal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();}));
  const pending=controller.execute(token,{callId:id},req,res);await ready;req.emit('aborted');
  expect(await pending).toMatchObject({state:'unknown'});expect(host.closeOperationSession).toHaveBeenCalledOnce();
 });
 it('closes a saved server session while new-work flags are disabled without a computer',async()=>{
  flags.system_role_mcp=false;expect(await controller.close(token,{sessionId,package:pkg()})).toEqual({closed:true});
  expect(host.closeOperationSession).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
 });
 it('persists completion before returning HTTP and retries only the identical receipt after an ACK loss',async()=>{
  loseReceiptAck=true;expect(await controller.execute(token,{callId:id},req,res)).toMatchObject({state:'succeeded'});
  expect(host.operationCall).toHaveBeenCalledOnce();expect(dispatches).toBe(1);expect(receipts).toHaveLength(2);expect(receipts[0]).toEqual(receipts[1]);
  expect(receipts[0]).toMatchObject({callId:id,proof,result:{state:'succeeded',value:{text:'Page loaded'}}});
 });
 it('delivers the completed private receipt after caller cancellation and flag-off without starting another tool',async()=>{
  host.operationCall.mockImplementationOnce(async()=>{flags.system_role_mcp=false;req.emit('aborted');return {content:[{type:'text',text:'Completed before cancellation'}]};});
  expect(await controller.execute(token,{callId:id},req,res)).toMatchObject({state:'succeeded'});
  expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({callId:id,proof,result:{value:{text:'Completed before cancellation'}}});expect(host.operationCall).toHaveBeenCalledOnce();
 });
 it('rejects a missing dispatch proof before any physical operation or receipt callback',async()=>{
  delete context.call.proof;expect(await controller.execute(token,{callId:id},req,res)).toMatchObject({state:'failed'});
  expect(host.operationTools).not.toHaveBeenCalled();expect(dispatches).toBe(0);expect(receipts).toHaveLength(0);
 });
});
