import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {acknowledgeBuildCleanup,mayRecoverBuildStage} from '../src/package-build/build-cleanup';
import type {BuildRow} from '../src/package-build/package-build.model';

describe('Recovery requires positive cleanup evidence instead of SQL ownership',()=>{
    let root:string,row:BuildRow;
    beforeEach(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-cleanup-proof-'));
        row={id:randomUUID(),execution_nonce:randomUUID(),execution_host:os.hostname(),execution_pid:process.pid,execution_started:true,state:'CANCELLING'} as BuildRow;
        await fs.mkdir(path.join(root,row.id));
    });
    afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
    const reaped=async(root:string,row:BuildRow,nonce=row.execution_nonce)=>{await fs.mkdir(path.join(root,'.process-reaped'),{recursive:true});await fs.writeFile(path.join(root,'.process-reaped',row.id+'.'+row.execution_nonce+'.json'),JSON.stringify({nonce,reaped:true}));};
    it('A builder reap proof cannot authorize deleting stage while its parent still lives',async()=>{
        await reaped(root,row);expect(await mayRecoverBuildStage(root,row)).toBe(false);
    });
    it('A positive old-worker acknowledgment permits recovery after child reaping AND stage removal',async()=>{
        await fs.rm(path.join(root,row.id),{recursive:true});await acknowledgeBuildCleanup(root,row);
        await acknowledgeBuildCleanup(root,row);
        expect(await mayRecoverBuildStage(root,row)).toBe(true);
    });
    it('A dead same-host parent still requires the exact started-builder reap nonce',async()=>{
        const child=spawn(process.execPath,['-e',''],{stdio:'ignore'});await new Promise<void>(resolve=>child.once('close',()=>resolve()));row.execution_pid=child.pid;
        expect(await mayRecoverBuildStage(root,row)).toBe(false);
        await reaped(root,row,randomUUID());expect(await mayRecoverBuildStage(root,row)).toBe(false);
        await reaped(root,row);expect(await mayRecoverBuildStage(root,row)).toBe(true);
    });
    it('A dead skill/preparing owner needs no builder reap because no START was durably admitted',async()=>{
        const child=spawn(process.execPath,['-e',''],{stdio:'ignore'});await new Promise<void>(resolve=>child.once('close',()=>resolve()));row.execution_pid=child.pid;row.execution_started=false;
        expect(await mayRecoverBuildStage(root,row)).toBe(true);
    });
    it('A foreign host and a reused live PID remain pending and preserve the stage',async()=>{
        await reaped(root,row);row.execution_host='foreign-host';expect(await mayRecoverBuildStage(root,row)).toBe(false);
        row.execution_host=os.hostname();row.execution_pid=process.pid;expect(await mayRecoverBuildStage(root,row)).toBe(false);
        expect(await fs.readdir(path.join(root,row.id))).toEqual([]);
    });
    it('A symlink acknowledgment is not followed into another directory',async()=>{
        const foreign=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-foreign-proof-'));
        try{await fs.writeFile(path.join(foreign,row.id+'.'+row.execution_nonce+'.json'),JSON.stringify({nonce:row.execution_nonce,reaped:true}));
            await fs.symlink(foreign,path.join(root,'.cleanup-acks'));
            expect(await mayRecoverBuildStage(root,row)).toBe(false);
        }finally{await fs.rm(foreign,{recursive:true,force:true});}
    });
});
