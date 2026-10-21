import type {Request} from 'express';
import {describe,expect,it} from 'vitest';
import {deviceCredentialTransport} from '../src/security/device-credential-transport';
const request=(remoteAddress?:string,headers:Record<string,unknown>={},encrypted=false)=>({socket:{remoteAddress,encrypted},headers}) as unknown as Request;

/** Credential forwarding requires socket-authenticated TLS or an explicitly trusted TLS proxy. */
describe('Device credential transport',()=>{
 it('accepts direct TLS even without proxy headers or a development hostname',()=>{expect(deviceCredentialTransport(request('203.0.113.8',{},true),{NODE_ENV:'production'})).toBe(true);});
 it.each(['203.0.113.8','::ffff:203.0.113.8'])('accepts HTTPS forwarding only from a configured literal proxy socket %s',remote=>{
  expect(deviceCredentialTransport(request(remote,{'x-forwarded-proto':'https'}),{NODE_ENV:'production',NEUROCENTER_TLS_PROXY_ADDRESSES:' 203.0.113.8, ::1 '})).toBe(true);
 });
 it.each([
  ['203.0.113.9',{'x-forwarded-proto':'https'},'203.0.113.8'],
  ['203.0.113.8',{'x-forwarded-proto':'http'},'203.0.113.8'],
  ['203.0.113.8',{'x-forwarded-proto':'https,http'},'203.0.113.8'],
  ['203.0.113.8',{'x-forwarded-proto':['https']},'203.0.113.8'],
  ['203.0.113.8',{'x-forwarded-proto':'https'},'203.0.113.8,proxy.example.test'],
  ['203.0.113.8',{'x-forwarded-proto':'https'},''],
  [undefined,{'x-forwarded-proto':'https'},'203.0.113.8'],
 ])('rejects spoofed or invalid proxy TLS evidence %#',(remote,headers,trusted)=>{
  expect(deviceCredentialTransport(request(remote as string,headers as Record<string,unknown>),{NODE_ENV:'production',NEUROCENTER_TLS_PROXY_ADDRESSES:trusted as string})).toBe(false);
 });
 it.each([
  ['127.0.0.1','localhost:4000'],['::ffff:127.0.0.1','127.0.0.1:4000'],['::1','[::1]:4000'],
 ])('allows an explicit development loopback socket/host pair %s %s',(remote,host)=>{expect(deviceCredentialTransport(request(remote,{host}),{NODE_ENV:'development'})).toBe(true);});
 it.each([
  ['127.0.0.1','localhost:4000','production'],['203.0.113.8','localhost:4000','development'],
  ['127.0.0.1','untrusted.example.test','development'],['127.0.0.1','localhost@evil.test','development'],
  ['127.0.0.1','localhost/path','development'],['127.0.0.1','localhost?query','development'],
  ['127.0.0.1','localhost#fragment','development'],['127.0.0.1','local host','development'],
  ['127.0.0.1',undefined,'development'],['127.0.0.1',1,'development'],['127.0.0.1','[','development'],
 ])('rejects an unsafe plaintext credential transport %#',(remote,host,mode)=>{
  expect(deviceCredentialTransport(request(remote as string,{host}),{NODE_ENV:mode as string})).toBe(false);
 });
 it('uses the process environment by default and requires encrypted to be boolean true',()=>{
  expect(deviceCredentialTransport({socket:{remoteAddress:'203.0.113.99',encrypted:'true'},headers:{host:'localhost'}} as unknown as Request)).toBe(false);
 });
});
