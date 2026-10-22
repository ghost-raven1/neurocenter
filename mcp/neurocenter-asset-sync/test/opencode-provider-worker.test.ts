import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {runProviderJob} from '../src/features/opencode-providers/worker.js';
import {BRIDGE_CAPABILITIES} from '../src/bridge/protocol.js';
import {normalizeProviderReport,OPENCODE_PROVIDER_CAPABILITY} from '../src/features/opencode-providers/contract.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();});
describe('OpenCode provider job adapter',()=>{
 it('advertises the actual supported capability and produces contract-valid inert preparation/status',async()=>{
  const f=await providerFixture();cleanup.push(f.cleanup);expect(BRIDGE_CAPABILITIES).toContain(OPENCODE_PROVIDER_CAPABILITY);
  const job={id:randomUUID(),kind:'prepare-opencode-provider',project_id:f.descriptor.projectId,payload:{descriptor:f.descriptor}},authorize=vi.fn(noop),authorizeSave=vi.fn(noop);
  const prepared=await runProviderJob(job,authorize,authorizeSave);expect(normalizeProviderReport(job.kind,prepared,f.descriptor)).toEqual(prepared);
  const status=await runProviderJob({...job,kind:'get-opencode-provider-status'},authorize,authorizeSave);expect(normalizeProviderReport('get-opencode-provider-status',status,f.descriptor)).toMatchObject({state:'missing',ready:false});expect(authorize).toHaveBeenCalled();expect(authorizeSave).not.toHaveBeenCalled();
 });
 it.each(['missing','foreign-project','unknown'])('refuses %s job before mutation or server-save permit',async scenario=>{
  const f=await providerFixture();cleanup.push(f.cleanup);const authorize=vi.fn(noop),authorizeSave=vi.fn(noop);
  await expect(runProviderJob({id:randomUUID(),kind:scenario==='unknown'?'other':'prepare-opencode-provider',project_id:scenario==='foreign-project'?'prj-other':f.descriptor.projectId,payload:scenario==='missing'?{}:{descriptor:f.descriptor}},authorize,authorizeSave)).rejects.toThrow();expect(authorizeSave).not.toHaveBeenCalled();
 });
});
