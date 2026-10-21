import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {HOSTED_MCP_TTL_MS,issueHostedMcpTicket,validHostedMcpSession,verifyHostedMcpTicket,type HostedMcpClaim} from '../src/features/mcp-host/ticket';
const secret='qa-host-secret-at-least-sixteen-characters',now=new Date('2026-10-22T00:00:00Z').getTime();
const session=()=>({deviceId:'device-owner',projectId:'prj-private',assetId:'plugin-hosted',version:2,manifest:'a'.repeat(64)});
const claim=()=>({artifactSha256:'b'.repeat(64),entrypoint:'runtime/index.mjs',executable:false,name:'QA hosted MCP',compressedBytes:1024,session:session()});
const signed=(raw:string,key=secret)=>{const payload=Buffer.from(raw).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
const validPayload=()=>({...claim(),exp:now+HOSTED_MCP_TTL_MS});

/** Signed sessions preserve one revocable device/project/package pin and omit internal-only child state. */
describe('Hosted MCP tickets source protocol',()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.stubEnv('NEUROCENTER_MCP_HOST_SECRET',secret);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-internal-fallback-secret');});
 afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
 it('round-trips exact public claims and bounds normal issuance to thirty days',()=>{
  expect(verifyHostedMcpTicket(issueHostedMcpTicket(claim()))).toEqual(validPayload());
  const withInventory={...claim(),unpackedBytes:5000,filesCount:7,executable:true};expect(verifyHostedMcpTicket(issueHostedMcpTicket(withInventory))).toEqual({...withInventory,exp:now+HOSTED_MCP_TTL_MS});
 });
 it('excludes a private research process identity and incidental caller fields from public tickets',()=>{
  const input={...claim(),researchSessionId:'private-research-session',privateKey:'must-not-serialize'};
  const token=issueHostedMcpTicket(input);const body=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString());expect(body).toEqual(validPayload());expect(token).not.toContain(input.researchSessionId);
 });
 it('expires a previously valid token, and secret rotation immediately invalidates it',()=>{
  const token=issueHostedMcpTicket(claim());vi.advanceTimersByTime(HOSTED_MCP_TTL_MS+1);expect(verifyHostedMcpTicket(token)).toBeUndefined();vi.setSystemTime(now);vi.stubEnv('NEUROCENTER_MCP_HOST_SECRET','a-different-approved-host-secret');expect(verifyHostedMcpTicket(token)).toBeUndefined();
 });
 it('supports an explicit internal fallback secret but fails closed when neither secret is sufficient',()=>{
  vi.stubEnv('NEUROCENTER_MCP_HOST_SECRET','');const token=issueHostedMcpTicket(claim());expect(verifyHostedMcpTicket(token)?.session).toEqual(session());
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','short');expect(()=>issueHostedMcpTicket(claim())).toThrow('Секрет');expect(verifyHostedMcpTicket(token)).toBeUndefined();
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');expect(()=>issueHostedMcpTicket(claim())).toThrow('Секрет');expect(verifyHostedMcpTicket(token)).toBeUndefined();
 });
 it.each([undefined,null,[],{}, {...session(),version:0},{...session(),version:1.5},{...session(),version:'2'}, {...session(),manifest:'A'.repeat(64)},{...session(),deviceId:''},{...session(),projectId:'p'.repeat(201)},{...session(),assetId:1},{...session(),extra:'field'}])('does not issue or accept an invalid scoped session %#',value=>{
  expect(validHostedMcpSession(value)).toBe(false);expect(()=>issueHostedMcpTicket({...claim(),session:value} as never)).toThrow('назначение');expect(verifyHostedMcpTicket(signed(JSON.stringify({...validPayload(),session:value})))).toBeUndefined();
 });
 it('keeps device/project/package signatures independent and rejects changed identities',()=>{
  const a=issueHostedMcpTicket(claim()),b=issueHostedMcpTicket({...claim(),session:{...session(),deviceId:'other-device',projectId:'other-project'}});expect(a).not.toBe(b);expect(verifyHostedMcpTicket(a)?.session).toEqual(session());
  const [payload,signature]=a.split('.'),data=JSON.parse(Buffer.from(payload,'base64url').toString());data.session.projectId='other-project';expect(verifyHostedMcpTicket(Buffer.from(JSON.stringify(data)).toString('base64url')+'.'+signature)).toBeUndefined();
 });
 it.each(['','.', 'missing-signature', 'x.y', 'a'.repeat(2049), null, 7])('rejects malformed or unbounded ticket framing %#',token=>{expect(verifyHostedMcpTicket(token as string)).toBeUndefined();});
 it('rejects both wrong-length and equal-length forged signatures',()=>{
  const token=issueHostedMcpTicket(claim()),payload=token.split('.')[0];expect(verifyHostedMcpTicket(payload+'.'+Buffer.alloc(32).toString('base64url'))).toBeUndefined();expect(verifyHostedMcpTicket(payload+'.AA')).toBeUndefined();
 });
 it.each(['not JSON','null','[]','"text"','1'])('rejects signed non-object payload %#',raw=>{expect(verifyHostedMcpTicket(signed(raw))).toBeUndefined();});
 it.each([
  {artifactSha256:'invalid'},{artifactSha256:1},{entrypoint:''},{entrypoint:'x'.repeat(241)},{entrypoint:'../escape.mjs'},{entrypoint:'/absolute.mjs'},{entrypoint:2},
  {executable:'true'},{name:''},{name:1},{name:'x'.repeat(201)},{compressedBytes:'1024'},{compressedBytes:0},{compressedBytes:1.5},{compressedBytes:2*1024**3+1},
  {exp:'later'},{exp:now-1},{unpackedBytes:0},{unpackedBytes:1.5},{unpackedBytes:1024**3+1},{filesCount:0},{filesCount:1.5},{filesCount:20001},
 ])('rejects signed but invalid execution metadata %#',patch=>{expect(verifyHostedMcpTicket(signed(JSON.stringify({...validPayload(),...patch})))).toBeUndefined();});
 it('accepts explicit resource boundaries and strips unrelated signed fields',()=>{
  const body={...validPayload(),compressedBytes:2*1024**3,unpackedBytes:1024**3,filesCount:20000,extra:'ignored',researchSessionId:'not-public'};const checked=verifyHostedMcpTicket(signed(JSON.stringify(body))) as HostedMcpClaim;
  expect(checked.compressedBytes).toBe(body.compressedBytes);expect(checked.unpackedBytes).toBe(body.unpackedBytes);expect(checked.filesCount).toBe(body.filesCount);expect(checked).not.toHaveProperty('researchSessionId');expect(checked).not.toHaveProperty('extra');
 });
});
