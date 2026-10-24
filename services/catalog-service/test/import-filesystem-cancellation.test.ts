import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>undefined}));

const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-import-fs-cancel-'));roots.push(root);return root;}

/** Interrupt a real FileHandle stream at its first readable event, without timing a disk race. */
async function abortFirstRead(filename:string,controller:AbortController){
    const probe=await fs.open(filename,'r'),prototype=Object.getPrototypeOf(probe),original=prototype.createReadStream;await probe.close();
    const create=vi.spyOn(prototype,'createReadStream').mockImplementation(function(this:fs.FileHandle,options:object){
        const stream=original.call(this,options);stream.once('readable',()=>controller.abort(Error('Controlled first-chunk cancellation')));return stream;
    });
    return create;
}

describe('Import cancellation interrupts actual filesystem hashing before registry/publication',()=>{
    it('stops runtime archive inspection at its first compressed chunk without registering it',async()=>{
        const root=await fixture(),runtime=artifactFixture(),filename=path.join(root,'input.tar.gz'),abort=new AbortController(),query=vi.fn();
        await fs.writeFile(filename,runtime.archive);vi.stubEnv('RUNTIME_ARTIFACT_DIR',path.join(root,'runtime'));
        const streams=await abortFirstRead(filename,abort),artifacts=new RuntimeArtifacts({pool:{query}} as never);
        await expect(artifacts.importArchive(filename,runtime.descriptor,abort.signal)).rejects.toThrow();
        expect(streams).toHaveBeenCalledOnce();expect(abort.signal.aborted).toBe(true);expect(query).not.toHaveBeenCalled();
        await expect(fs.stat(path.join(root,'runtime'))).rejects.toMatchObject({code:'ENOENT'});
    });
    it('stops a local blob copy on its first source chunk and removes its stage without publishing a blob',async()=>{
        const root=await fixture(),bytes=Buffer.alloc(256*1024,0x6e),sha256=createHash('sha256').update(bytes).digest('hex'),archivePath=path.join(root,'original.source');
        await fs.writeFile(archivePath,bytes);const abort=new AbortController(),query=vi.fn(),store=new AssetBlobStore({query} as never,path.join(root,'blobs'));
        await abortFirstRead(archivePath,abort);
        await expect(store.ingestLocal([{archivePath,sha256,bytes:bytes.length,filename:'original.source'}],randomUUID(),abort.signal)).rejects.toThrow();
        expect(abort.signal.aborted).toBe(true);expect(query).not.toHaveBeenCalled();expect(await fs.readdir(store.directory)).toEqual([]);
        expect(await fs.readFile(archivePath)).toEqual(bytes);
    });
});
