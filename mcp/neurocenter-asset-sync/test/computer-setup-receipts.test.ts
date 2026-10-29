import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {computerSetupFixture} from './computer-setup.fixture.js';
import {stateDir} from '../src/bridge/state.js';
import {saveCompletion,pendingCompletions,deliverCompletions} from '../src/bridge/completions.js';
import {observeOpenCodeCli} from '../src/features/computer-setup/process.js';
import {runComputerSetupJob,recoverComputerSetupJobs} from '../src/features/computer-setup/executor.js';
import {readCliReceipt,cliProcessJournal,completeCliReceipt,queueCliCompletion,recoverComputerSetupCompletions,CliCleanupError} from '../src/features/computer-setup/receipts.js';
import {roleMcpProcessOwner,closeRoleMcpProcess} from '../src/features/system-role-mcp/owned-process.js';
import {atomicText} from '../src/bridge/atomic-file.js';

describe('Durable per-CLI ownership and delivery recovery',()=>{
    let fixture:Awaited<ReturnType<typeof computerSetupFixture>>;
    const children:ChildProcess[]=[];
    beforeEach(async()=>{fixture=await computerSetupFixture();});
    afterEach(async()=>{
        for(const child of children.splice(0))if(child.exitCode===null&&child.signalCode===null){const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exit;}
        await recoverComputerSetupJobs().catch(()=>{});
        vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});
    });
    async function completed(){
        await fixture.writeCli(`console.log('1.14.48');`);
        const result=await observeOpenCodeCli(fixture.context,async()=>{},new AbortController().signal);
        return completeCliReceipt(fixture.receipt(),{...fixture.identity,state:'succeeded',message:'Пользовательский OpenCode найден.',result:{...result}});
    }
    it('persists nonce before wrapper creation and exact owner before execution permission',async()=>{
        const marker=path.join(fixture.temporary,'permission.json');
        await fixture.writeCli(`const fs=require('node:fs'),root=${JSON.stringify(stateDir())},job=${JSON.stringify(fixture.identity.id)};const receipt=JSON.parse(fs.readFileSync(require('node:path').join(root,'computer-setup-jobs',job+'.json'),'utf8'));fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({phase:receipt.phase,owner:!!receipt.process.owner,nonce:receipt.process.nonce}));console.log('1.14.48');`);
        await observeOpenCodeCli(fixture.context,async()=>{},new AbortController().signal);
        expect(JSON.parse(await fs.readFile(marker,'utf8'))).toMatchObject({phase:'started',owner:true,nonce:fixture.receipt().process!.nonce});
    },20000);
    it('recovers a closed journal after failure before durable outbox ownership without rerunning the command',async()=>{
        const receipt=await completed(),save=vi.fn(async()=>{throw Error('private simulated outbox failure');});
        await expect(queueCliCompletion(receipt,save)).rejects.toThrow('outbox failure');
        expect((await readCliReceipt(fixture.identity.id))?.phase).toBe('closed');
        await recoverComputerSetupCompletions(saveCompletion);
        expect(await pendingCompletions()).toEqual([receipt.completion]);
        await expect(fs.stat(path.join(stateDir(),'computer-setup-jobs',fixture.identity.id+'.json'))).rejects.toMatchObject({code:'ENOENT'});
        await expect(fs.stat(receipt.process!.receipt)).resolves.toBeDefined();
    },20000);
    it('replays the same fsynced outbox after a crash immediately before the archive rename',async()=>{
        const receipt=await completed(),rename=fs.rename.bind(fs);let crashed=false;
        const fault=vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(!crashed&&String(to).includes('computer-setup-completed')){crashed=true;throw Error('private crash before archive');}await rename(from,to);});
        await expect(queueCliCompletion(receipt,saveCompletion)).rejects.toThrow('before archive');const before=await pendingCompletions();fault.mockRestore();
        await recoverComputerSetupCompletions(saveCompletion);expect(await pendingCompletions()).toEqual(before);
        expect((await readCliReceipt(fixture.identity.id))?.completion).toEqual(receipt.completion);
    },20000);
    it('retries actual directory fsync failure after the successful archive rename before accepting empty-active recovery',async()=>{
        const receipt=await completed(),open=fs.open.bind(fs),destination=path.join(stateDir(),'computer-setup-completed'),source=path.join(stateDir(),'computer-setup-jobs');
        const syncs:string[]=[];let failing=true;
        vi.spyOn(fs,'open').mockImplementation(async(...args)=>{
            const handle=await open(...args);
            if(args[0]===destination||args[0]===source){
                const sync=handle.sync.bind(handle);
                vi.spyOn(handle,'sync').mockImplementation(async()=>{syncs.push(String(args[0]));if(failing&&args[0]===destination)throw Object.assign(new Error('private archive fsync failure'),{code:'EIO'});await sync();});
            }
            return handle;
        });
        await expect(queueCliCompletion(receipt,saveCompletion)).rejects.toThrow('archive fsync failure');
        await expect(fs.stat(path.join(source,fixture.identity.id+'.json'))).rejects.toMatchObject({code:'ENOENT'});
        expect(await readCliReceipt(fixture.identity.id)).toEqual(receipt);
        await expect(recoverComputerSetupCompletions(saveCompletion,[receipt])).rejects.toThrow('archive fsync failure');
        expect(await pendingCompletions()).toEqual([receipt.completion]);
        failing=false;await recoverComputerSetupCompletions(saveCompletion,[receipt]);expect(syncs.slice(-2)).toEqual([destination,source]);
        const send=vi.fn(async()=>({ok:true}));await deliverCompletions(send);await recoverComputerSetupCompletions(saveCompletion);expect(await pendingCompletions()).toEqual([]);
        const authorize=vi.fn();await runComputerSetupJob({id:fixture.identity.id,lease:fixture.identity.lease,kind:'inspect-opencode-cli',payload:{schemaVersion:1,scope:'global',deviceId:fixture.identity.deviceId}},fixture.identity.deviceId,authorize);
        expect(authorize).not.toHaveBeenCalled();expect(send).toHaveBeenCalledOnce();expect((await readCliReceipt(fixture.identity.id))?.completion).toEqual(receipt.completion);
    },20000);
    it('keeps the failed executor and stop blocked until both directory durability and the exact closed archive are recovered',async()=>{
        vi.resetModules();const executor=await import('../src/features/computer-setup/executor.js');
        await fixture.writeCli(`console.log('1.14.48');`);
        const job={...fixture.identity,id:randomUUID()},open=fs.open.bind(fs),directory=path.join(stateDir(),'computer-setup-completed');let failing=true;
        vi.spyOn(fs,'open').mockImplementation(async(...args)=>{
            const handle=await open(...args);
            if(args[0]===directory){const sync=handle.sync.bind(handle);vi.spyOn(handle,'sync').mockImplementation(async()=>{if(failing)throw Object.assign(new Error('private archive fsync failure'),{code:'EIO'});await sync();});}
            return handle;
        });
        const command={id:job.id,lease:job.lease,kind:'inspect-opencode-cli',payload:{schemaVersion:1,scope:'global',deviceId:job.deviceId}},authorize=vi.fn(async()=>{});
        await expect(executor.runComputerSetupJob(command,job.deviceId,authorize)).rejects.toThrow('archive fsync failure');
        const receipt=await readCliReceipt(job.id),archive=path.join(directory,job.id+'.json');expect(receipt?.phase).toBe('closed');
        await expect(fs.stat(path.join(stateDir(),'computer-setup-jobs',job.id+'.json'))).rejects.toMatchObject({code:'ENOENT'});
        await expect(executor.recoverComputerSetupJobs()).rejects.toThrow('archive fsync failure');
        const another={...command,id:randomUUID()},nextAuthorize=vi.fn();
        await expect(executor.runComputerSetupJob(another,job.deviceId,nextAuthorize)).rejects.toThrow('недоступна');expect(nextAuthorize).not.toHaveBeenCalled();
        await expect(executor.stopComputerSetupJobs()).rejects.toThrow('archive fsync failure');
        failing=false;
        const replacementLease=randomUUID(),replacement={...receipt!,job:{...receipt!.job,lease:replacementLease},completion:{...receipt!.completion!,lease:replacementLease}};
        await atomicText(archive,JSON.stringify(replacement),0o600);
        await expect(executor.recoverComputerSetupJobs()).rejects.toThrow('Завершение проверки OpenCode не подтверждено');
        await expect(executor.stopComputerSetupJobs()).rejects.toThrow('archive fsync failure');
        await atomicText(archive,JSON.stringify(receipt),0o600);await executor.recoverComputerSetupJobs();
        await expect(executor.stopComputerSetupJobs()).resolves.toBeUndefined();expect(await readCliReceipt(job.id)).toEqual(receipt);
        expect((await pendingCompletions()).find(value=>value.id===job.id)).toEqual(receipt!.completion);
    },25000);
    it('blocks cleanup uncertainty without signalling a foreign process or writing an ordinary failure completion',async()=>{
        const owner=await roleMcpProcessOwner(),journal=await cliProcessJournal(fixture.receipt(),()=>{});
        await journal.retain(owner);const kill=vi.spyOn(process,'kill');
        await expect(recoverComputerSetupCompletions(saveCompletion)).rejects.toBeInstanceOf(CliCleanupError);
        expect(kill).not.toHaveBeenCalled();expect(await pendingCompletions()).toEqual([]);
        expect((await readCliReceipt(fixture.identity.id))?.phase).toBe('started');
    });
    it('refuses to reuse a closed observation for another lease without executing or publishing it',async()=>{
        const receipt=await completed();await queueCliCompletion(receipt,saveCompletion);await deliverCompletions(async()=>({ok:true}));
        const authorize=vi.fn();
        await expect(runComputerSetupJob({id:fixture.identity.id,lease:randomUUID(),kind:'inspect-opencode-cli',payload:{schemaVersion:1,scope:'global',deviceId:fixture.identity.deviceId}},fixture.identity.deviceId,authorize)).rejects.toBeInstanceOf(CliCleanupError);
        expect(authorize).not.toHaveBeenCalled();expect(await pendingCompletions()).toEqual([]);expect(await readCliReceipt(fixture.identity.id)).toEqual(receipt);
        await recoverComputerSetupJobs();
    },20000);
    it('publishes only a static failure without an observation when authorization is lost after actual execution',async()=>{
        await fixture.writeCli(`console.log('1.14.48');`);const job={...fixture.identity,id:randomUUID()};let calls=0;
        await runComputerSetupJob({id:job.id,lease:job.lease,kind:'inspect-opencode-cli',payload:{schemaVersion:1,scope:'global',deviceId:job.deviceId}},job.deviceId,async()=>{if(++calls===4)throw Error('PRIVATE_AUTH_SECRET');});
        const completion=(await pendingCompletions()).find(value=>value.id===job.id);
        expect(completion).toMatchObject({state:'failed',result:{}});expect(completion!.result).not.toHaveProperty('checkedAt');expect(JSON.stringify(completion)).not.toContain('PRIVATE_');
        const receipt=await readCliReceipt(job.id);expect(receipt?.phase).toBe('closed');
        expect(JSON.parse(await fs.readFile(receipt!.process!.receipt,'utf8')).closed).toBe(true);
    },20000);
    it('does not steal a live worker ownership record even when no server job is active',async()=>{
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});children.push(child);
        await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
        const item={...fixture.receipt(),worker:await roleMcpProcessOwner(child.pid!,process.execPath)};
        await atomicText(path.join(stateDir(),'computer-setup-jobs',fixture.identity.id+'.json'),JSON.stringify(item),0o600);
        await expect(recoverComputerSetupCompletions(saveCompletion)).rejects.toBeInstanceOf(CliCleanupError);
        expect(child.exitCode).toBeNull();expect(await pendingCompletions()).toEqual([]);
    });
    it('recovers an actual killed worker and its detached descendant before saving a failure, without a second CLI dispatch',async()=>{
        const job={id:randomUUID(),lease:randomUUID(),deviceId:fixture.identity.deviceId},marker=path.join(fixture.temporary,'crash-children.json'),count=path.join(fixture.temporary,'dispatch-count');
        await fixture.writeCli(`const fs=require('node:fs'),file=${JSON.stringify(marker)},count=${JSON.stringify(count)};fs.writeFileSync(count,String(fs.existsSync(count)?Number(fs.readFileSync(count,'utf8'))+1:1));const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.once('spawn',()=>fs.writeFileSync(file,JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000);`);
        const harness=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./computer-setup-crash.fixture.ts',import.meta.url)),fixture.temporary,JSON.stringify(job)],{env:{...process.env,NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});children.push(harness);
        let errors='';harness.stderr!.on('data',chunk=>{errors+=chunk;});
        await vi.waitFor(async()=>expect(await fs.readFile(marker,'utf8'),errors).toMatch(/^\[/),{timeout:10000});
        const record=await readCliReceipt(job.id);expect(record?.process?.owner).toBeDefined();
        const exit=new Promise<void>(resolve=>harness.once('exit',()=>resolve()));harness.kill('SIGKILL');await exit;
        await recoverComputerSetupJobs();
        const result=(await pendingCompletions()).find(value=>value.id===job.id);expect(result).toMatchObject({state:'failed',result:{}});
        for(const pid of JSON.parse(await fs.readFile(marker,'utf8')) as number[])expect(()=>process.kill(pid,0)).toThrow();
        expect((await readCliReceipt(job.id))?.phase).toBe('closed');
        await recoverComputerSetupJobs();expect(await fs.readFile(count,'utf8')).toBe('1');
        // The archived exact wrapper proof remains usable after journal recovery.
        await closeRoleMcpProcess(record!.process!.owner!,record!.process!.nonce,record!.process!.receipt);
    },25000);
});
