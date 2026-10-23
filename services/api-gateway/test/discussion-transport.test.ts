import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {proxyHttpFixture,reply} from './proxy-http.fixture';
import {requiredFeatureFlags} from '../src/features/feature-flag-gate';
import {discussionAttachmentUploadRoute,discussionAttachmentDownloadRoute,DISCUSSION_ATTACHMENT_MAX_BYTES} from '../../shared/discussion-attachment-route.cjs';

let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');f=await proxyHttpFixture();});
afterEach(async()=>{await f.close();vi.unstubAllEnvs();});
const id='01234567-89ab-4cde-8f01-23456789abcd';
const route='/api/discussions/attachments';
const upload=(body:Uint8Array,headers:Record<string,string>={})=>fetch(f.url+route+'?targetType=catalog&targetId=skill%3Acommon%2Ftesting',{method:'POST',headers:{cookie:'bridge_session=qa-only','content-type':'application/octet-stream','x-file-name':'test.txt','x-request-key':id,...headers},body});

it('forwards an actual raw POST and exact slash target through authenticated gateway',async()=>{
 const bytes=Buffer.from('not JSON: UTF-8 привет');
 f.state.handler=async(req,res,call)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(part as Buffer);expect(Buffer.concat(chunks)).toEqual(bytes);expect(call.method).toBe('POST');expect(new URL(call.url,f.origin).searchParams.get('targetId')).toBe('skill:common/testing');expect(call.headers['x-bridge-actor']).toBeTruthy();reply(res,201,{id,bytes:bytes.length});};
 const response=await upload(bytes);expect(response.status).toBe(201);expect(await response.json()).toEqual({id,bytes:bytes.length});
});
it('refuses JSON uploads before business bytes',async()=>{
 const bad=await upload(Buffer.from('x'),{'content-type':'application/json'});expect(bad.status).toBe(415);expect(f.business()).toEqual([]);
});
it('blocks new file upload when either discussion capability is disabled',async()=>{
 f.state.flags.discussion_attachments=false;const response=await upload(Buffer.from('text'));expect(response.status).toBe(403);expect(f.business()).toEqual([]);
 f.state.flags.discussion_attachments=true;f.state.flags.discussions=false;expect((await upload(Buffer.from('text'))).status).toBe(403);expect(f.business()).toEqual([]);
});
it('preserves exact binary download and private safe disposition, including HEAD',async()=>{
 const bytes=Buffer.from([0,255,13,10,42]);
 f.state.handler=(_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(bytes.length),'content-disposition':"attachment; filename=download; filename*=UTF-8''test.bin"});res.end(bytes);};
 for(const method of ['GET','HEAD']){
  const response=await fetch(f.url+route+'/'+id+'/content',{method,headers:{cookie:'bridge_session=qa-only'}});
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('content-security-policy')).toContain('sandbox');expect(Buffer.from(await response.arrayBuffer())).toEqual(method==='HEAD'?Buffer.alloc(0):bytes);
 }
});
it('does not return private bytes after fresh access refusal',async()=>{
 f.state.allowed=false;const response=await fetch(f.url+route+'/'+id+'/content',{headers:{cookie:'bridge_session=qa-only'}});expect(response.status).toBe(403);expect(f.business()).toEqual([]);
});
it('returns structured denial instead of decoding an error as a file',async()=>{
 f.state.handler=(_req,res)=>reply(res,403,{message:'Доступ отозван'});const response=await fetch(f.url+route+'/'+id+'/content',{headers:{cookie:'bridge_session=qa-only'}});expect(response.status).toBe(403);expect(await response.json()).toEqual({message:'Доступ отозван'});
});
it('keeps replay/removal/history available OFF while gating new editing',()=>{
 for(const [method,path] of [['POST','/api/discussions/comments'],['DELETE','/api/discussions/comments/'+id],['GET',route+'/'+id+'/content'],['PUT','/api/catalog-reactions'],['DELETE','/api/catalog-reactions']])expect(requiredFeatureFlags(method,path)).toEqual([]);
 expect(requiredFeatureFlags('PATCH','/api/discussions/comments/'+id)).toEqual(['discussions']);expect(requiredFeatureFlags('PUT','/api/help/hello')).toEqual(['help_center']);
});
it('admits only exact canonical raw routes and bounds the attachment size',()=>{
 expect(DISCUSSION_ATTACHMENT_MAX_BYTES).toBe(10*1024**2);expect(discussionAttachmentUploadRoute('POST',route)).toBe(route);
 for(const path of [route+'/../attachments',route+'/extra','/api//discussions/attachments',route+'%ZZ'])expect(discussionAttachmentUploadRoute('POST',path)).toBeUndefined();
 expect(discussionAttachmentDownloadRoute('GET',route+'/'+id+'/content')).toBeTruthy();expect(discussionAttachmentDownloadRoute('POST',route+'/'+id+'/content')).toBeUndefined();
});
