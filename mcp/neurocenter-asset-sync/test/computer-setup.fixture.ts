import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {beginCliReceipt,cliProcessJournal,closeCliReceipt,settleCliReceipt,type CliReceipt} from '../src/features/computer-setup/receipts.js';
import type {CliObservationContext} from '../src/features/computer-setup/process.js';

/** All executable bytes, HOME, XDG directories and durable receipts belong to this harmless fixture. */
export async function computerSetupFixture(){
    const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-cli-observation-')));
    const home=path.join(temporary,'home'),bin=path.join(temporary,'bin'),sdk=path.join(temporary,'sdk');
    for(const directory of[home,bin,sdk])await fs.mkdir(directory,{mode:0o700});
    vi.stubEnv('NEUROCENTER_BRIDGE_HOME',path.join(temporary,'private'));vi.stubEnv('NEUROCENTER_URL','http://computer-setup.example.test');
    vi.stubEnv('HOME',home);vi.stubEnv('USERPROFILE',home);vi.stubEnv('PATH',bin);
    vi.stubEnv('XDG_CONFIG_HOME',path.join(home,'config'));vi.stubEnv('XDG_DATA_HOME',path.join(home,'data'));vi.stubEnv('XDG_CACHE_HOME',path.join(home,'cache'));
    const identity={id:randomUUID(),lease:randomUUID(),deviceId:randomUUID()};
    let receipt:CliReceipt=await beginCliReceipt(identity);
    const context:CliObservationContext={deviceId:identity.deviceId,jobId:identity.id,home,directories:[bin],bridgeRoots:[sdk],
        environment:{...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),NODE_OPTIONS:''},
        journal:()=>cliProcessJournal(receipt,next=>{receipt=next;})};
    const executable=path.join(bin,'opencode');
    const writeCli=async(code:string,file=executable)=>{await fs.writeFile(file,'#!'+process.execPath+'\n'+code,{mode:0o700});return file;};
    return {temporary,home,bin,sdk,context,identity,executable,writeCli,
        receipt:()=>receipt,
        async close(){receipt=await settleCliReceipt(receipt);await closeCliReceipt(receipt);}};
}
