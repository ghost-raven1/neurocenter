import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {bridgeRuntimeCached,publishBridgeRuntimeFiles,validateBridgeRuntimeRelease} from '../bridge-runtime-artifacts.mjs';
import {opencodeVersion} from '../opencode-platforms.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc bridge artifacts '));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const version='9.8.7',buildId='b'.repeat(64),target='darwin-arm64',file=`neurocenter-asset-sync-${target}-${version}.tgz`,bytes=Buffer.from('Synthetic runtime');
    const metadata={version,buildId,target,nodeVersion:'24.22.0',ragSupported:true,probeEngine:{version:opencodeVersion,file:'bin/opencode-probe',sha256:'a'.repeat(64)},sha256:sha(bytes),bytes:bytes.length};
    const artifact={file,url:`https://github.com/ghost-raven1/neurocenter-assets/releases/download/bridge-v${version}/${file}`,metadata};
    await fs.writeFile(path.join(directory,file),bytes);await fs.writeFile(path.join(directory,file+'.json'),JSON.stringify(metadata));await fs.writeFile(path.join(directory,file+'.sha256'),metadata.sha256+'\n');
    return {directory,file,bytes,metadata,release:{schemaVersion:1,version,buildId,release:'bridge-v'+version,artifacts:[artifact]},
        cached:()=>bridgeRuntimeCached({directory,version,buildId,target,metadata})};
}
test('Native bridge delivery проверяет version, build, target, size, pin и source URL',async t=>{
    const f=await fixture(t);assert.deepEqual(validateBridgeRuntimeRelease(f.release),f.release);
    for(const change of [value=>{value.artifacts[0].metadata.buildId='f'.repeat(64);},value=>{value.artifacts[0].metadata.version='9.8.6';},
        value=>{value.artifacts[0].url='https://untrusted.example/runtime.tgz';},value=>{value.artifacts[0].metadata.bytes=1024**3+1;},value=>{value.artifacts.push(value.artifacts[0]);}]){
        const bad=structuredClone(f.release);change(bad);assert.throws(()=>validateBridgeRuntimeRelease(bad));
    }
});
test('Local producer cache проверяет реальные bytes и sidecar, не загружает другой release',async t=>{
    const f=await fixture(t);assert.equal(await f.cached(),true);
    await fs.writeFile(path.join(f.directory,f.file),Buffer.alloc(f.bytes.length));assert.equal(await f.cached(),false);
    await fs.writeFile(path.join(f.directory,f.file),f.bytes);await fs.writeFile(path.join(f.directory,f.file+'.json'),JSON.stringify({...f.metadata,buildId:'c'.repeat(64)}));assert.equal(await f.cached(),false);
});
test('Симлинк producer cache не считается готовым файлом',async t=>{
    const f=await fixture(t);await fs.rename(path.join(f.directory,f.file),path.join(f.directory,'foreign'));await fs.symlink('foreign',path.join(f.directory,f.file));assert.equal(await f.cached(),false);
});
test('Ошибка публикации второго sidecar восстанавливает весь предыдущий producer комплект',async t=>{
    const f=await fixture(t),candidate=path.join(f.directory,'candidate'),previous=path.join(f.directory,'previous'),files=[f.file,f.file+'.json',f.file+'.sha256'];
    await fs.mkdir(candidate);for(const file of files)await fs.writeFile(path.join(candidate,file),'next bytes');
    const before=await Promise.all(files.map(file=>fs.readFile(path.join(f.directory,file)))),rename=fs.rename;let failed=false;
    fs.rename=async(source,target)=>{if(source===path.join(candidate,f.file+'.json')&&!failed){failed=true;throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});}return rename(source,target);};
    try{await assert.rejects(publishBridgeRuntimeFiles({candidate,previous,directory:f.directory,files}),{code:'ENOSPC'});}finally{fs.rename=rename;}
    assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(path.join(f.directory,file)))),before);
});
