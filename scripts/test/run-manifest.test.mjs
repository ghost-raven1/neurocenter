import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {saveRunManifest} from '../workspace/run-lifecycle.mjs';

async function fixture(t){
    const directory=await fs.mkdtemp(path.join(tmpdir(),'nc atomic run receipt '));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    return {directory,file:path.join(directory,'manifest.json')};
}

test('a receipt replacement exposes complete JSON with private permissions',async t=>{
    const f=await fixture(t);await saveRunManifest(f.file,{complete:false});
    await saveRunManifest(f.file,{complete:true,summary:{passed:3}});
    assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),{complete:true,summary:{passed:3}});
    if(process.platform!=='win32')assert.equal((await fs.stat(f.file)).mode&0o777,0o600);
    assert.deepEqual(await fs.readdir(f.directory),['manifest.json']);
});

test('failed publication preserves the previous incomplete receipt and removes its private stage',async t=>{
    const f=await fixture(t);await saveRunManifest(f.file,{complete:false,state:'running'});
    const rename=fs.rename;
    fs.rename=async()=>{throw Object.assign(Error('Controlled disk failure'),{code:'ENOSPC'});};
    try{await assert.rejects(saveRunManifest(f.file,{complete:true}),{code:'ENOSPC'});}finally{fs.rename=rename;}
    assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),{complete:false,state:'running'});
    assert.deepEqual(await fs.readdir(f.directory),['manifest.json']);
});

test('serialization failure cannot replace a readable earlier receipt',async t=>{
    const f=await fixture(t);await saveRunManifest(f.file,{complete:false});
    const invalid={};invalid.self=invalid;
    await assert.rejects(saveRunManifest(f.file,invalid),TypeError);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),{complete:false});
    assert.deepEqual(await fs.readdir(f.directory),['manifest.json']);
});
