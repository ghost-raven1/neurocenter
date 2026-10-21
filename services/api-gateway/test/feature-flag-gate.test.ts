import axios from 'axios';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {featureFlagsFailure,requiredFeatureFlags} from '../src/features/feature-flag-gate';
import {proxyHttpFixture} from './proxy-http.fixture';

describe.sequential('Gateway feature admission source over real local HTTP',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;const http=axios.create({validateStatus:()=>true});
 beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');f=await proxyHttpFixture();});afterEach(async()=>{await f.close();vi.unstubAllEnvs();});
 it('never reads flags for an empty historical-read requirement',async()=>{expect(await featureFlagsFailure(http,f.origin+'/flags',[])).toBeUndefined();expect(f.calls).toEqual([]);});
 it('rechecks a complete current decision and preserves structured blocked-by dependencies',async()=>{
  expect(await featureFlagsFailure(http,f.origin+'/flags',['research_tools'])).toBeUndefined();f.state.flags.model_chat=false;const failure=await featureFlagsFailure(http,f.origin+'/flags',['research_tools']);expect(failure).toMatchObject({status:403,code:'feature-disabled',feature:'research_tools'});expect(failure!.blockedBy).toContain('model_chat');expect(f.calls).toHaveLength(2);
 });
 it.each([403,500])('fails closed on flag service status %s without exposing upstream details',async status=>{f.state.flagsStatus=status;const failure=await featureFlagsFailure(http,f.origin+'/flags',['tool_builds']);expect(failure).toMatchObject({status:503,code:'feature-flags-unavailable'});expect(JSON.stringify(failure)).not.toContain(f.origin);});
 it.each([{flags:{tool_builds:true}},'not a snapshot',null])('rejects an incomplete or malformed flag response %#',async data=>{
  f.state.flagsPayload=data===null?[]:data;expect(await featureFlagsFailure(http,f.origin+'/flags',['tool_builds'])).toMatchObject({status:503,code:'feature-flags-unavailable'});
 });
 it('does not follow a redirect to a different authority',async()=>{
  f.state.flagsRedirect=f.origin+'/foreign/forbidden';expect(await featureFlagsFailure(http,f.origin+'/flags',['tool_builds'])).toMatchObject({status:503});expect(f.calls).toHaveLength(1);expect(f.calls[0].kind).toBe('flags');
 });
 it('maps a local transport failure to the same generic unavailable response',async()=>{
  expect(await featureFlagsFailure({get:async()=>{throw new Error('private credential endpoint');}} as never,f.origin,['tool_builds'])).toMatchObject({status:503,code:'feature-flags-unavailable'});
 });
 it('keeps cleanup endpoints callable when new execution is disabled',()=>{expect(requiredFeatureFlags('DELETE','/api/tool-builds/uploads/01234567-89ab-4cde-8f01-23456789abcd')).toEqual([]);expect(requiredFeatureFlags('POST','/api/tool-builds')).toContain('tool_builds');});
});
