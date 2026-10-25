import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {prepareOpenCodeProvider,openOpenCodeProvider} from '../src/features/opencode-providers/index.js';
import {closeProviderSessions} from '../src/features/opencode-providers/server.js';
import {providerConfig,providerProof} from '../src/features/opencode-providers/receipt.js';
import {normalizeProviderReport} from '../src/features/opencode-providers/contract.js';
import {jobContext} from '../src/bridge/state.js';
import {deliverCompletions,pendingCompletions,saveCompletion,type Completion} from '../src/bridge/completions.js';
import {recoverFileJobs} from '../src/bridge/installation-files.js';
import {journalDirectory,parseJournal} from '../src/bridge/installation-journal.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{await closeProviderSessions();await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();vi.restoreAllMocks();});

describe('Provider wizard opening and later filesystem completion',()=>{
 it.each(['acknowledged','lost-ack'] as const)('a later HTTP save never reuses the %s opening job',async delivery=>{
  const f=await providerFixture();cleanup.push(f.cleanup);
  const file=path.join(f.root,providerConfig),manual='// KEEP MANUAL SETTINGS\n{"model":"manual/default","provider":{"manual":{"models":{"m":{}}}}}\n';
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,manual,{mode:0o640});await fs.chmod(file,0o640);
  const preparation=await prepareOpenCodeProvider(f.descriptor,noop),job={id:randomUUID(),lease:randomUUID(),deviceId:f.descriptor.deviceId};
  let address='';const open=vi.fn(async(url:string)=>{address=url;return true;}),authorizeSave=vi.fn(noop);
  // The real worker's AsyncLocalStorage also belongs to the server's later HTTP callbacks.
  const report=await jobContext.run(job,()=>openOpenCodeProvider(f.descriptor,{...preparation,openJobId:job.id,authorizeSave,open},noop));
  const completion:Completion={...job,state:'succeeded',message:'Provider wizard opened.',result:report};
  await saveCompletion(completion);const delivered:Completion[]=[];
  const send=async(item:Completion)=>{
   expect(normalizeProviderReport('open-opencode-provider',item.result,f.descriptor,false,preparation.preparationId)).toEqual(report);
   delivered.push(item);
  };
  if(delivery==='acknowledged')await deliverCompletions(send);
  else await expect(deliverCompletions(async(item)=>{await send(item);throw Error('lost ACK');})).rejects.toThrow('lost ACK');
  const url=new URL(address),post=(route:string,body:unknown,csrf='')=>fetch(url.origin+route,{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json','X-Provider-CSRF':csrf},body:JSON.stringify(body)});
  const form=await(await post('/session',{token:url.hash.slice(1)})).json() as {csrf:string};
  authorizeSave.mockClear();const saved=await post('/save',{apiKey:'LOCAL_FIXTURE_SECRET',expectedRevision:null},form.csrf);
  expect(saved.status).toBe(200);expect(await saved.json()).toEqual({ready:true,state:'configured'});expect(authorizeSave).toHaveBeenCalled();
  const expected=delivery==='acknowledged'?[]:[completion];
  expect(await pendingCompletions()).toEqual(expected);
  const directory=journalDirectory(f.root),names=await fs.readdir(path.join(directory,'history'));expect(names).toHaveLength(1);
  const journalFile=path.join(directory,'history',names[0]!),journalBytes=await fs.readFile(journalFile),journal=parseJournal(journalBytes.toString('utf8'),f.root);
  expect(journal.state).toBe('committed');expect(journal.job).toBeUndefined();
  expect(journal.changes.find(change=>change.relative===providerConfig)?.before).toBe(manual);
  const config=await fs.readFile(file);expect(config.toString()).toContain('// KEEP MANUAL SETTINGS');expect(config.toString()).toContain('manual/default');
  expect(config.toString()).not.toContain('LOCAL_FIXTURE_SECRET');expect((await fs.stat(file)).mode&0o777).toBe(0o640);
  expect((await providerProof(f.context))?.receipt.providerId).toBe(f.descriptor.providerId);
  // Startup recovery and transport retries retain the exact opening report without another browser or write.
  await recoverFileJobs();await deliverCompletions(send);await recoverFileJobs();await deliverCompletions(send);
  expect(await pendingCompletions()).toEqual([]);expect(open).toHaveBeenCalledOnce();
  expect(delivered).toEqual(delivery==='acknowledged'?[completion]:[completion,completion]);
  expect(await fs.readFile(file)).toEqual(config);expect(await fs.readFile(journalFile)).toEqual(journalBytes);
 });
});
