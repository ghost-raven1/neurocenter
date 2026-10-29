import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/features/system-role-mcp/owned-process.js',()=>({roleMcpProcessOwner:async()=>({pid:12345,uid:process.getuid?.()??0,birth:'fixture-owned',entry:'/fixture/owned.js'}),roleMcpOwnerAlive:async()=>false,RoleMcpCleanupError:class extends Error{}}));
vi.mock('../src/features/computer-setup/auth-owner.js',()=>({assertOpenCodeAuthOwner:vi.fn(async()=>({assertCurrent:async()=>{}})),stopOpenCodeAuthOwnerChecks:vi.fn(async()=>{})}));
vi.mock('../src/features/computer-setup/executor.js',()=>({recoverComputerSetupJobs:vi.fn(async()=>{})}));
vi.mock('../src/bridge/completions.js',()=>({saveCompletion:vi.fn(async()=>{})}));
vi.mock('../src/features/opencode-local-providers/server.js',()=>({startGlobalProvidersSession:vi.fn(async()=>({close:async()=>{}})),closeGlobalProvidersSessions:vi.fn(async()=>{}),closeGlobalProvidersSession:vi.fn(async()=>{})}));
vi.mock('../src/bridge/open-browser.js',()=>({openVerificationPage:vi.fn(async()=>true)}));
import {runGlobalProvidersJob,recoverGlobalProvidersJobs} from '../src/features/opencode-local-providers/index.js';
import {beginGlobalReceipt,readGlobalReceipt} from '../src/features/opencode-local-providers/receipts.js';
import {startGlobalProvidersSession} from '../src/features/opencode-local-providers/server.js';
import {saveCompletion} from '../src/bridge/completions.js';
import {writeState} from '../src/bridge/state.js';
import {assertOpenCodeAuthOwner} from '../src/features/computer-setup/auth-owner.js';
import {recoverComputerSetupJobs} from '../src/features/computer-setup/executor.js';
import {CliCleanupError} from '../src/features/computer-setup/receipts.js';
let home:string;
const deviceId='11111111-1111-4111-8111-111111111111',token='SYNTHETIC_DEVICE_PRIVATE_123';
const job=()=>({id:randomUUID(),lease:randomUUID(),kind:'open-opencode-global-providers',project_id:null,payload:{schemaVersion:1,scope:'global',deviceId,expiresAt:new Date(Date.now()+60000).toISOString()}});
beforeEach(async()=>{
    vi.clearAllMocks();home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc global worker ')));vi.stubEnv('NEUROCENTER_BRIDGE_HOME',path.join(home,'bridge'));vi.stubEnv('NEUROCENTER_URL','https://worker.global.test');
    vi.spyOn(os,'homedir').mockReturnValue(home);vi.stubEnv('XDG_CONFIG_HOME',path.join(home,'config'));vi.stubEnv('XDG_DATA_HOME',path.join(home,'data'));vi.stubEnv('XDG_STATE_HOME',path.join(home,'state'));
    for(const name of ['OPENCODE_AUTH_CONTENT','OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT','OPENCODE_CONFIG_DIR'])vi.stubEnv(name,undefined);
    await writeState('credentials',{deviceId,email:'fixture@example.test',token});
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(home,{recursive:true,force:true});});
it('the same accepted opening queues one durable receipt without opening another private window',async()=>{
    const input=job(),authorize=vi.fn(async()=>{});await runGlobalProvidersJob(input,deviceId,authorize);await runGlobalProvidersJob(input,deviceId,authorize);
    expect(startGlobalProvidersSession).toHaveBeenCalledOnce();expect(saveCompletion).toHaveBeenCalledOnce();expect(JSON.stringify(vi.mocked(saveCompletion).mock.calls)).not.toContain(token);expect((await readGlobalReceipt(input.id))?.outboxed).toBe(true);
});
it('loss of outbox ACK recovers the completed opening without calling the opener again',async()=>{
    const input=job();vi.mocked(saveCompletion).mockRejectedValueOnce(Error('ACK lost'));await expect(runGlobalProvidersJob(input,deviceId,async()=>{})).rejects.toThrow();expect((await readGlobalReceipt(input.id))?.phase).toBe('closed');
    await recoverGlobalProvidersJobs();expect(startGlobalProvidersSession).toHaveBeenCalledOnce();expect(saveCompletion).toHaveBeenCalledTimes(2);expect((await readGlobalReceipt(input.id))?.outboxed).toBe(true);
});
it('an interrupted accepted opening is classified unknown rather than blindly recreated',async()=>{
    const input=job();await beginGlobalReceipt({...input,deviceId});await recoverGlobalProvidersJobs();expect(startGlobalProvidersSession).not.toHaveBeenCalled();expect(vi.mocked(saveCompletion).mock.calls[0][0].result).toMatchObject({status:'failed',issue:'unknown'});
});
it('an unsupported ordinary CLI prevents window opening and returns only a safe readonly explanation',async()=>{
    const input=job();vi.mocked(assertOpenCodeAuthOwner).mockRejectedValueOnce(Object.assign(Error('UNSUPPORTED_PRIVATE_STDOUT'),{code:'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'}));await runGlobalProvidersJob(input,deviceId,async()=>{});
    expect(startGlobalProvidersSession).not.toHaveBeenCalled();expect(vi.mocked(saveCompletion).mock.calls[0][0].result).toMatchObject({status:'failed',issue:'unsupported-version'});expect(JSON.stringify(vi.mocked(saveCompletion).mock.calls)).not.toContain('UNSUPPORTED_PRIVATE_STDOUT');
});
it('unknown CLI process cleanup keeps the global receipt started until the shared physical cleanup fence succeeds',async()=>{
    const input=job();vi.mocked(assertOpenCodeAuthOwner).mockRejectedValueOnce(new CliCleanupError(Error('OWNED_PROBE_STILL_RUNNING')));await expect(runGlobalProvidersJob(input,deviceId,async()=>{})).rejects.toBeInstanceOf(CliCleanupError);
    expect((await readGlobalReceipt(input.id))?.phase).toBe('started');expect(saveCompletion).not.toHaveBeenCalled();
    vi.mocked(recoverComputerSetupJobs).mockRejectedValueOnce(new CliCleanupError(Error('OWNED_PROBE_STILL_RUNNING')));await expect(recoverGlobalProvidersJobs()).rejects.toBeInstanceOf(CliCleanupError);expect((await readGlobalReceipt(input.id))?.phase).toBe('started');expect(saveCompletion).not.toHaveBeenCalled();
    await recoverGlobalProvidersJobs();expect((await readGlobalReceipt(input.id))?.phase).toBe('closed');expect(startGlobalProvidersSession).not.toHaveBeenCalled();
});
