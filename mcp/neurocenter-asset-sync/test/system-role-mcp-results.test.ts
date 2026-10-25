import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {stateDir,writeState} from '../src/bridge/state.js';
import {captureRoleMcpIdentity} from '../src/features/system-role-mcp/api.js';
import {saveRoleMcpResult,sendRoleMcpResult,deliverRoleMcpResults} from '../src/features/system-role-mcp/receipts.js';

describe('private result recovery belongs to its exact connection',()=>{
 let temporary:string|undefined;
 afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();if(temporary)await fs.rm(temporary,{recursive:true,force:true});});
 async function setup(){({temporary}=await workspaceFixture());vi.stubEnv('NEUROCENTER_API_URL','http://127.0.0.1:9');const deviceId=randomUUID();await writeState('credentials',{deviceId,token:'private-result-token',email:'fixture@example.test'});return deviceId;}
 const body=()=>({jobId:randomUUID(),lease:randomUUID(),callId:randomUUID(),result:{state:'unknown',message:'Confirmation lost; no replay'}});
 it('retains a lost result acknowledgement and retries the same result without executing a tool',async()=>{
  const deviceId=await setup(),value=body(),fetch=vi.fn().mockRejectedValueOnce(new Error('lost ACK')).mockResolvedValue(new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
  await sendRoleMcpResult(value,deviceId,'call');const file=path.join(stateDir(),'system-role-mcp-receipts',value.callId+'.json');expect((await fs.stat(file)).mode&0o077).toBe(0);
  await deliverRoleMcpResults(deviceId);expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);await expect(fs.lstat(file)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('preserves a v2 unknown result after API or credential changes without sending it',async()=>{
  const deviceId=await setup(),value=body(),identity=await captureRoleMcpIdentity();await saveRoleMcpResult(value,deviceId,'call',identity);
  const file=path.join(stateDir(),'system-role-mcp-receipts',value.callId+'.json'),before=await fs.readFile(file),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  vi.stubEnv('NEUROCENTER_API_URL','http://127.0.0.1:10');await deliverRoleMcpResults(deviceId);vi.stubEnv('NEUROCENTER_API_URL',identity.apiUrl);
  await writeState('credentials',{deviceId,token:'different-token',email:'fixture@example.test'});await deliverRoleMcpResults(deviceId);
  expect(fetch).not.toHaveBeenCalled();expect(await fs.readFile(file)).toEqual(before);expect(before.toString()).not.toContain('private-result-token');
 });
 it('retains legacy unscoped pointer and private values without adopting them into v2',async()=>{
  const deviceId=await setup(),callId=randomUUID(),directory=path.join(stateDir(),'system-role-mcp-receipts');await fs.mkdir(directory,{mode:0o700});
  const file=path.join(directory,callId+'.json'),legacy=JSON.stringify({id:callId,jobId:randomUUID(),lease:randomUUID(),deviceId,kind:'call',digest:'0'.repeat(64)});await fs.writeFile(file,legacy,{mode:0o600});
  const privateDirectory=path.join(stateDir(),'local-configuration');await fs.mkdir(privateDirectory,{mode:0o700});const privateFile=path.join(privateDirectory,'0'.repeat(64)+'.json');await fs.writeFile(privateFile,'legacy private unknown result',{mode:0o600});
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await deliverRoleMcpResults(deviceId);expect(fetch).not.toHaveBeenCalled();expect(await fs.readFile(file,'utf8')).toBe(legacy);expect(await fs.readFile(privateFile,'utf8')).toBe('legacy private unknown result');
 });
 it('retains an uncertain result when an HTTP200 has no positive acknowledgement',async()=>{
  const deviceId=await setup(),value=body();vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}')));await sendRoleMcpResult(value,deviceId,'call');expect(await fs.readFile(path.join(stateDir(),'system-role-mcp-receipts',value.callId+'.json'),'utf8')).toContain('Confirmation lost');
 });
});
