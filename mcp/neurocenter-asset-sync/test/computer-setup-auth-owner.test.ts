import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';

let root:string,home:string,bin:string,marker:string,cli:string;
const deviceId='11111111-1111-4111-8111-111111111111';
beforeEach(async()=>{
    vi.resetModules();root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc auth-owner ')));home=path.join(root,'home');bin=path.join(root,'bin');marker=path.join(root,'executed.json');cli=path.join(bin,'opencode');
    await fs.mkdir(home,{mode:0o700});await fs.mkdir(bin,{mode:0o700});
    vi.stubEnv('HOME',home);vi.stubEnv('USERPROFILE',home);vi.stubEnv('PATH',bin);vi.stubEnv('NEUROCENTER_BRIDGE_HOME',path.join(root,'private'));vi.stubEnv('NEUROCENTER_URL','https://auth-owner.example.test');
    for(const name of ['XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME'])vi.stubEnv(name,path.join(home,name.toLowerCase()));
});
afterEach(async()=>{
    const {recoverComputerSetupJobs}=await import('../src/features/computer-setup/executor.js');await recoverComputerSetupJobs().catch(()=>{});
    vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});
});
async function writeCli(version='1.14.48',hang=false){
    await fs.writeFile(cli,'#!'+process.execPath+'\n'+`require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));`+(hang?'setInterval(()=>{},1000);':`console.log(${JSON.stringify(version)});`),{mode:0o700});
}
async function started(){await vi.waitFor(async()=>{expect(await fs.readFile(marker,'utf8')).toBeTruthy();},{timeout:3000,interval:10});return JSON.parse(await fs.readFile(marker,'utf8')) as {pid:number;args:string[]};}
async function empty(){const {pendingCompletions}=await import('../src/bridge/completions.js');expect(await pendingCompletions()).toEqual([]);}

it('uses a fresh actual PATH fixed --version and never queues its private local identity',async()=>{
    await writeCli();const {assertOpenCodeAuthOwner}=await import('../src/features/computer-setup/auth-owner.js'),authorize=vi.fn(async()=>{});
    const proof=await assertOpenCodeAuthOwner(deviceId,authorize);expect(Object.keys(proof)).toEqual(['assertCurrent']);await proof.assertCurrent();
    expect(JSON.parse(await fs.readFile(marker,'utf8')).args).toEqual(['--version']);expect(authorize).toHaveBeenCalled();await empty();
    const {stateDir}=await import('../src/bridge/state.js');expect(await fs.readdir(path.join(stateDir(),'computer-setup-jobs'))).toEqual([]);
    const {stopOpenCodeAuthOwnerChecks}=await import('../src/features/computer-setup/auth-owner.js');await stopOpenCodeAuthOwnerChecks();
    await expect(proof.assertCurrent()).rejects.toHaveProperty('code','OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED');
});
it.each(['1.15.0','1.14.47','1.14.48\nSYNTHETIC_PRIVATE_OUTPUT'])('rejects unsupported or untrusted stdout %j without exposing it',async version=>{
    await writeCli(version);const {assertOpenCodeAuthOwner}=await import('../src/features/computer-setup/auth-owner.js');
    const error=await assertOpenCodeAuthOwner(deviceId,async()=>{}).catch(value=>value);expect(error.code).toBe('OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED');expect(error.message).not.toContain('SYNTHETIC_PRIVATE_OUTPUT');await empty();
});
it('rejects missing PATH CLI and an SDK/probe shadow without executing a later CLI',async()=>{
    const {assertOpenCodeAuthOwner}=await import('../src/features/computer-setup/auth-owner.js');await expect(assertOpenCodeAuthOwner(deviceId,async()=>{})).rejects.toHaveProperty('code','OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED');
    await writeCli();const first=path.join(root,'first'),sdk=path.join(root,'opencode-probe');await fs.mkdir(first);await fs.writeFile(sdk,'SHOULD_NOT_EXECUTE',{mode:0o700});await fs.symlink(sdk,path.join(first,'opencode'));vi.stubEnv('PATH',first+path.delimiter+bin);
    await expect(assertOpenCodeAuthOwner(deviceId,async()=>{})).rejects.toHaveProperty('code','OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED');await expect(fs.stat(marker)).rejects.toHaveProperty('code','ENOENT');await empty();
});
it('returned publish proof rejects CLI replacement even when the replacement prints the same version',async()=>{
    await writeCli();const {assertOpenCodeAuthOwner}=await import('../src/features/computer-setup/auth-owner.js');const proof=await assertOpenCodeAuthOwner(deviceId,async()=>{});
    await fs.rename(cli,cli+'.previous');await writeCli();await expect(proof.assertCurrent()).rejects.toThrow('изменился');await empty();
});
it('a changed executable while fresh permission is pending cannot receive an execution permit',async()=>{
    await writeCli();let release!:()=>void,reached!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>reached=resolve);
    const {assertOpenCodeAuthOwner}=await import('../src/features/computer-setup/auth-owner.js');const probe=assertOpenCodeAuthOwner(deviceId,async()=>{reached();await waiting;});
    await entered;await fs.rename(cli,cli+'.previous');await writeCli('1.15.0');release();await expect(probe).rejects.toHaveProperty('code','OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED');
    await expect(fs.stat(marker)).rejects.toHaveProperty('code','ENOENT');await empty();
});
it('running fixed probe blocks recovery; stop waits for owned child closure and leaves no server completion',async()=>{
    await writeCli('1.14.48',true);const helper=await import('../src/features/computer-setup/auth-owner.js'),executor=await import('../src/features/computer-setup/executor.js');
    const probe=helper.assertOpenCodeAuthOwner(deviceId,async()=>{}),failure=probe.catch(error=>error);const child=await started();
    await expect(executor.recoverComputerSetupJobs()).rejects.toHaveProperty('name','Error');await helper.stopOpenCodeAuthOwnerChecks();
    expect((await failure).code).toBe('OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED');expect(()=>process.kill(child.pid,0)).toThrow();await executor.recoverComputerSetupJobs();await empty();
},20000);
it('a hung version command reaches its bounded deadline and closes the exact child',async()=>{
    await writeCli('1.14.48',true);const {assertOpenCodeAuthOwner}=await import('../src/features/computer-setup/auth-owner.js'),probe=assertOpenCodeAuthOwner(deviceId,async()=>{}),failure=probe.catch(error=>error);const child=await started();
    expect((await failure).code).toBe('OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED');expect(()=>process.kill(child.pid,0)).toThrow();await empty();
},20000);
it('uncertain private journal retirement stays a cleanup error until recovery succeeds',async()=>{
    await writeCli();const helper=await import('../src/features/computer-setup/auth-owner.js'),executor=await import('../src/features/computer-setup/executor.js');
    const unlink=fs.unlink.bind(fs);let failed=true;vi.spyOn(fs,'unlink').mockImplementation(async file=>{if(failed&&String(file).includes('computer-setup-jobs'))throw Object.assign(Error('controlled journal failure'),{code:'EIO'});await unlink(file);});
    await expect(helper.assertOpenCodeAuthOwner(deviceId,async()=>{})).rejects.toThrow('не подтверждено');await empty();await expect(executor.recoverComputerSetupJobs()).rejects.toThrow('не подтверждено');
    failed=false;await executor.recoverComputerSetupJobs();await helper.stopOpenCodeAuthOwnerChecks();await empty();
},20000);
