import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {SnapshotService} from '../src/snapshots/snapshot.service';
import {SnapshotSigner} from '../src/snapshots/snapshot-signature';

const previous=process.env.SNAPSHOT_EXECUTOR_ENABLED;
afterEach(()=>{if(previous===undefined)delete process.env.SNAPSHOT_EXECUTOR_ENABLED;else process.env.SNAPSHOT_EXECUTOR_ENABLED=previous;});

/** A fresh old heartbeat cannot enable a deliberately unconfigured runtime. */
function fixture(){
    const service=Object.create(SnapshotService.prototype) as SnapshotService;
    const query=vi.fn(async()=>({rowCount:1})),signature=vi.fn(async()=>({})),storage=vi.fn(()=>({}));
    Object.assign(service,{pool:{query},signer:{signature},storage});
    return {service,query,signature,storage};
}

describe('snapshot executor runtime admission',()=>{
    it('reports unavailable without reading old heartbeat or signing when the executor is disabled',async()=>{
        process.env.SNAPSHOT_EXECUTOR_ENABLED='0';const f=fixture();
        const result=await f.service.capabilities();
        expect(result.available).toBe(false);expect(result.reason).toMatch(/исполнитель/i);
        expect(f.query).not.toHaveBeenCalled();expect(f.signature).not.toHaveBeenCalled();expect(f.storage).not.toHaveBeenCalled();
    });
    it('rejects new publication before queue writes even if a previous executor was recently alive',async()=>{
        process.env.SNAPSHOT_EXECUTOR_ENABLED='0';const f=fixture(),owned=vi.fn();
        Object.assign(f.service,{actor:()=>({email:'owner@example.test',activeRole:'Админ'}),devices:{owned}});
        await expect(f.service.create({} as never,'project',{
            requestKey:'42a13170-b5d1-4dbf-936a-34506036b152',deviceId:'6275b999-f8ef-40fe-bb72-089042818f42',
            expectedBindingId:'a'.repeat(64),expectedHeadId:null,expectedHeadRevision:0,
        })).rejects.toMatchObject({status:503});
        expect(owned).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
    });
    it('keeps the existing signing and fresh executor checks when explicitly re-enabled',async()=>{
        process.env.SNAPSHOT_EXECUTOR_ENABLED='1';const f=fixture();
        expect((await f.service.capabilities()).available).toBe(true);
        expect(f.signature).toHaveBeenCalledWith({purpose:'configuration-check'});expect(f.query).toHaveBeenCalledOnce();
    });
    it.each(['false','unexpected'])('fails closed for an invalid runtime executor setting %s',async setting=>{
        process.env.SNAPSHOT_EXECUTOR_ENABLED=setting;const f=fixture();
        expect((await f.service.capabilities()).available).toBe(false);expect(f.query).not.toHaveBeenCalled();
    });
    it('still verifies an existing historical signature with the same private identity while new publication is disabled',async()=>{
        const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-snapshot-identity-'));
        try{
            const keyFile=path.join(directory,'signing.pem'),bytes=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
            await fs.writeFile(keyFile,bytes,{mode:0o600});const signer=new SnapshotSigner(keyFile),payload={snapshot:'accepted-history'};
            const signature=await signer.signature(payload);process.env.SNAPSHOT_EXECUTOR_ENABLED='0';
            await expect(new SnapshotSigner(keyFile).verify(payload,signature)).resolves.toBeUndefined();
            expect(await fs.readFile(keyFile,'utf8')).toEqual(bytes);
        }finally{await fs.rm(directory,{recursive:true,force:true});}
    });
});
