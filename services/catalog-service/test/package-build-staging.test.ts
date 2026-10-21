import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {stagingBytes,stagingLimit} from '../src/package-build/build-process';

describe('Python producer cache stays inside the bounded build staging',()=>{
    let root:string,producer:string;
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-python-staging-'));producer=path.join(root,'output','.source-cache','python-producer');await fs.mkdir(producer,{recursive:true});});
    afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
    it('Counts private cache files once and permits only their internal links',async()=>{
        await fs.mkdir(path.join(producer,'archive'));await fs.writeFile(path.join(producer,'archive','wheel'),'wheel bytes');
        await fs.symlink('archive',path.join(producer,'cache'));
        expect(await stagingBytes(root)).toBe(Buffer.byteLength('wheel bytes')+Buffer.byteLength('archive'));
    });
    it('Keeps symbolic links forbidden in the app payload and every other staging folder',async()=>{
        const app=path.join(root,'output','.build-test','app');await fs.mkdir(app,{recursive:true});
        await fs.writeFile(path.join(app,'server.py'),'print(1)');await fs.symlink('server.py',path.join(app,'alias.py'));
        await expect(stagingBytes(root)).rejects.toThrow('Сборка создала ссылку');
    });
    it('Rejects an escaping private cache link even when its target is still inside the job',async()=>{
        await fs.writeFile(path.join(root,'secret'),'private');await fs.symlink('../../../../secret',path.join(producer,'escape'));
        await expect(stagingBytes(root)).rejects.toThrow('выходит за приватную папку');
    });
    it('Rejects absolute links outside the producer and cyclic cache links',async()=>{
        await fs.symlink(os.tmpdir(),path.join(producer,'escape'));await expect(stagingBytes(root)).rejects.toThrow('выходит за приватную папку');
        await fs.unlink(path.join(producer,'escape'));await fs.symlink('loop',path.join(producer,'loop'));
        await expect(stagingBytes(root)).rejects.toThrow();
    });
    it('Includes producer bytes in the same four GiB quota',async()=>{
        const file=await fs.open(path.join(producer,'oversize'),'wx');try{await file.truncate(stagingLimit+1);}finally{await file.close();}
        await expect(stagingBytes(root)).rejects.toThrow('лимит staging 4 ГиБ');
    });
});
