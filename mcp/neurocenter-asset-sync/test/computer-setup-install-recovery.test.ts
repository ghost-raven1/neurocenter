import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {beginCliReceipt,markCliInstallPublication,markCliInstallStage,readCliReceipt,recoverComputerSetupCompletions} from '../src/features/computer-setup/receipts.js';
import {saveCompletion,pendingCompletions} from '../src/bridge/completions.js';

let temporary:string,home:string;
beforeEach(async()=>{
    temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-cli-install-recovery-')));home=path.join(temporary,'home');
    await fs.mkdir(path.join(home,'.local','bin'),{recursive:true,mode:0o700});
    vi.stubEnv('HOME',home);vi.stubEnv('NEUROCENTER_BRIDGE_HOME',path.join(temporary,'private'));vi.stubEnv('NEUROCENTER_URL','http://cli-install-recovery.example.test');
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(temporary,{recursive:true,force:true});});
async function started(){
    const identity={id:randomUUID(),lease:randomUUID(),deviceId:randomUUID()};
    const payload={schemaVersion:1,scope:'global',deviceId:identity.deviceId,source:{buildId:'a'.repeat(64),target:'darwin-arm64',version:'1.14.48',sha256:'b'.repeat(64)}};
    const receipt=await beginCliReceipt(identity,payload),file=path.join(home,'.local','bin','.opencode.install.'+randomUUID()+'.tmp');
    await fs.writeFile(file,'owned incomplete bytes',{mode:0o700});const info=await fs.stat(file),parent=await fs.stat(path.dirname(file));
    return {identity,payload,file,receipt:await markCliInstallStage(receipt,{file,dev:info.dev,ino:info.ino,parentDev:parent.dev,parentIno:parent.ino})};
}
it.each([false,true])('crash publication marker=%s recovers one safe receipt and only the owned staged inode',async published=>{
    const h=await started();if(published)h.receipt=await markCliInstallPublication(h.receipt);
    await recoverComputerSetupCompletions(saveCompletion);
    const completion=(await pendingCompletions())[0];expect(completion).toMatchObject({...h.identity,state:'failed',result:{status:published?'unknown':'failed',nextAction:published?'reconcile':'retry',failure:'interrupted',installedVersion:null,commandReady:false}});
    expect(JSON.stringify(completion)).not.toContain(home);await expect(fs.stat(h.file)).rejects.toMatchObject({code:'ENOENT'});
    expect((await readCliReceipt(h.identity.id))?.phase).toBe('closed');
    await recoverComputerSetupCompletions(saveCompletion);expect(await pendingCompletions()).toEqual([completion]);
});
it('publication recovery removes its stage link while preserving the installed destination',async()=>{
    const h=await started(),destination=path.join(home,'.local','bin','opencode');h.receipt=await markCliInstallPublication(h.receipt);await fs.link(h.file,destination);
    await recoverComputerSetupCompletions(saveCompletion);expect(await fs.readFile(destination,'utf8')).toBe('owned incomplete bytes');
    expect((await pendingCompletions())[0].result).toMatchObject({status:'unknown',nextAction:'reconcile'});
});
it('a replaced stage file blocks recovery without deleting the foreign file or claiming ordinary failure',async()=>{
    const h=await started(),old=h.file+'.old';await fs.rename(h.file,old);await fs.writeFile(h.file,'manual replacement',{mode:0o700});
    await expect(recoverComputerSetupCompletions(saveCompletion)).rejects.toThrow('не подтверждено');
    expect(await fs.readFile(h.file,'utf8')).toBe('manual replacement');expect(await pendingCompletions()).toEqual([]);expect((await readCliReceipt(h.identity.id))?.phase).toBe('started');
});
it('lost outbox write after a publish marker reuses the exact completion without copying the CLI',async()=>{
    const h=await started();h.receipt=await markCliInstallPublication(h.receipt);const save=vi.fn(async()=>{throw Error('controlled outbox failure');});
    await expect(recoverComputerSetupCompletions(save)).rejects.toThrow('outbox failure');const closed=await readCliReceipt(h.identity.id);expect(closed?.phase).toBe('closed');
    await recoverComputerSetupCompletions(saveCompletion);expect(await pendingCompletions()).toEqual([closed!.completion]);
    await expect(fs.stat(path.join(home,'.local','bin','opencode'))).rejects.toMatchObject({code:'ENOENT'});
});
