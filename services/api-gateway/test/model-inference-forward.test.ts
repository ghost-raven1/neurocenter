import {EventEmitter} from 'node:events';
import type {Request,Response} from 'express';
import {describe,expect,it,vi} from 'vitest';
import {forwardModelInference,modelInferenceRoute} from '../src/proxy/model-inference-forward';
import {chatId,jobId} from './proxy-http.fixture';
const payload={status:201,data:{answer:'approved'},headers:{},statusText:'Created',config:{}} as never;
const pair=(path='/api/models/model-qa/ollama/api/chat')=>({req:Object.assign(new EventEmitter(),{path,aborted:false}) as unknown as Request,res:Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false}) as unknown as Response});
const cleaned=(p:ReturnType<typeof pair>)=>{expect(p.req.listenerCount('aborted')).toBe(0);expect(p.res.listenerCount('close')).toBe(0);};

describe('Model inference transport source contracts',()=>{
 it.each(['api/chat','api/embed','v1/chat/completions','v1/embeddings'])('scopes model POST cancellation to %s',suffix=>{const path='/api/models/model-qa/ollama/'+suffix;expect(modelInferenceRoute('POST',path)).toBe(true);expect(modelInferenceRoute('GET',path)).toBe(false);});
 it.each([`/api/model-chats/${chatId}/attachments`,`/api/model-chats/${chatId}/turns`,`/api/model-chats/${chatId}/turns/${jobId}/retry`])('scopes saved-chat POST cancellation to %s',path=>{expect(modelInferenceRoute('POST',path)).toBe(true);expect(modelInferenceRoute('DELETE',path)).toBe(false);});
 it.each([undefined,'/api/models/model-qa/ollama/api/chat/extra',`/api/model-chats/${chatId}/context-preview`,'/api/model-chats/not-a-uuid/turns','/api/models'])('keeps non-inference actions outside the cancellation adapter %#',path=>{expect(modelInferenceRoute('POST',path)).toBe(false);});
 it.each([false,true])('sets distinct bounded response budgets while preserving the exact request config: saved=%s',async saved=>{
  const p=pair(saved?`/api/model-chats/${chatId}/turns`:undefined),http={request:vi.fn(async()=>payload)};const config={url:'http://fixture/model',headers:{'x-test':'preserve'},data:{messages:[]}};
  expect(await forwardModelInference(http as never,config,p.req,p.res)).toBe(payload);expect(http.request).toHaveBeenCalledWith({...config,timeout:saved?910000:610000,maxContentLength:(saved?64:8)*1024**2,signal:expect.any(AbortSignal)});cleaned(p);
 });
 it.each(['request','response','finished'])('does not contact Catalog for an already closed %s',async state=>{
  const p=pair();Object.assign(state==='request'?p.req:p.res,state==='request'?{aborted:true}:state==='response'?{destroyed:true}:{writableEnded:true});const http={request:vi.fn()};expect(await forwardModelInference(http as never,{},p.req,p.res)).toBeUndefined();expect(http.request).not.toHaveBeenCalled();cleaned(p);
 });
 it.each(['aborted','close'])('cancels only the current stream on %s and removes all lifecycle listeners',async event=>{
  const p=pair();let finish!:(value:unknown)=>void;const http={request:vi.fn((config:any)=>new Promise(resolve=>{finish=resolve;config.signal.addEventListener('abort',()=>finish(payload),{once:true});}))};
  const pending=forwardModelInference(http as never,{},p.req,p.res);(event==='aborted'?p.req:p.res).emit(event);expect(await pending).toBeUndefined();expect(http.request.mock.calls[0][0].signal.aborted).toBe(true);cleaned(p);
 });
 it('does not abort a successfully finished response or a normal request close',async()=>{
  const p=pair(),http={request:vi.fn(async()=>payload)};await forwardModelInference(http as never,{},p.req,p.res);const signal=(http.request.mock.calls[0] as any[])[0].signal;p.req.emit('close');Object.assign(p.res,{writableEnded:true});p.res.emit('close');expect(signal.aborted).toBe(false);cleaned(p);
 });
 it('propagates an upstream failure while connected, and suppresses an abort rejection after disconnection',async()=>{
  const p=pair(),failure=new Error('synthetic upstream failure');await expect(forwardModelInference({request:async()=>{throw failure;}} as never,{},p.req,p.res)).rejects.toBe(failure);cleaned(p);
  const next=pair();const http={request:vi.fn(async()=>{next.res.emit('close');throw failure;})};expect(await forwardModelInference(http as never,{},next.req,next.res)).toBeUndefined();cleaned(next);
 });
 it('does not abort an already completed response while a transport promise resolves',async()=>{
  const p=pair(),http={request:vi.fn(async()=>{Object.assign(p.res,{writableEnded:true});p.res.emit('close');return payload;})};expect(await forwardModelInference(http as never,{},p.req,p.res)).toBeUndefined();expect((http.request.mock.calls[0] as any[])[0].signal.aborted).toBe(false);cleaned(p);
 });
 it('keeps concurrent caller cancellation and successful response isolated',async()=>{
  const first=pair(),second=pair();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),http={request:vi.fn(async()=>{await gate;return payload;})};const a=forwardModelInference(http as never,{},first.req,first.res),b=forwardModelInference(http as never,{},second.req,second.res);first.req.emit('aborted');release();expect(await a).toBeUndefined();expect(await b).toBe(payload);cleaned(first);cleaned(second);
 });
});
