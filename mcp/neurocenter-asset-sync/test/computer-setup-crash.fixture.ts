import fs from 'node:fs/promises';
import path from 'node:path';
import {beginCliReceipt,cliProcessJournal,type CliReceipt} from '../src/features/computer-setup/receipts.js';
import {observeOpenCodeCli} from '../src/features/computer-setup/process.js';

// A private native fixture is deliberately killed by its parent after the harmless CLI starts.
const root=process.argv[2]!,job=JSON.parse(process.argv[3]!) as {id:string;lease:string;deviceId:string};
let receipt:CliReceipt=await beginCliReceipt(job);
const home=path.join(root,'home');
await observeOpenCodeCli({deviceId:job.deviceId,jobId:job.id,home,directories:[path.join(root,'bin')],bridgeRoots:[path.join(root,'sdk')],
    environment:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),NODE_OPTIONS:''},
    journal:()=>cliProcessJournal(receipt,next=>{receipt=next;})},async()=>{},AbortSignal.timeout(10000));
await fs.writeFile(path.join(root,'unexpected-completion'),'fixture should have been killed first');
