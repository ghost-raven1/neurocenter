import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseCatalogRebuildRequest} from '../../services/shared/catalog-rebuild-request.cjs';
import {catalogRebuildRequestPath,writeCatalogRebuildRequest} from '../workspace/catalog-rebuild-request.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
async function fixture(t){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc rebuild intent '))),checkout=path.join(directory,'проект 日本語');
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(path.join(checkout,'services/shared'),{recursive:true});
    await fs.writeFile(path.join(checkout,'package.json'),'{}');await fs.writeFile(path.join(checkout,'revision.txt'),'a'.repeat(64));
    await fs.writeFile(path.join(checkout,'services/shared/bundled-catalog.cjs'),`const fs=require('node:fs/promises'),path=require('node:path');module.exports.readBundledCatalog=async()=>({revision:(await fs.readFile(path.join(__dirname,'../../revision.txt'),'utf8')).trim()});`);
    await fs.writeFile(path.join(checkout,'services/shared/catalog-rebuild-request.cjs'),'module.exports=require('+JSON.stringify(path.join(root,'services/shared/catalog-rebuild-request.cjs'))+');');
    return {directory,checkout,file:catalogRebuildRequestPath(checkout)};
}

test('a checked local revision produces a private request with no actor, source path or executable input',async t=>{
    const f=await fixture(t),file=await writeCatalogRebuildRequest({root:f.checkout}),value=parseCatalogRebuildRequest(JSON.parse(await fs.readFile(file,'utf8')));
    assert.equal(file,f.file);assert.equal(value.sourceRevision,'a'.repeat(64));assert.deepEqual(Object.keys(value).sort(),['requestedAt','requestId','schemaVersion','sourceRevision'].sort());
    assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
    assert.deepEqual(await fs.readdir(path.dirname(file)),['current.json']);
});

test('another successful rebuild replaces the marker and retains its exact new revision',async t=>{
    const f=await fixture(t);await writeCatalogRebuildRequest({root:f.checkout});const before=JSON.parse(await fs.readFile(f.file,'utf8'));
    await fs.writeFile(path.join(f.checkout,'revision.txt'),'b'.repeat(64));await writeCatalogRebuildRequest({root:f.checkout});const after=JSON.parse(await fs.readFile(f.file,'utf8'));
    assert.notEqual(before.requestId,after.requestId);assert.equal(after.sourceRevision,'b'.repeat(64));assert.deepEqual(await fs.readdir(path.dirname(f.file)),['current.json']);
});

for(const failure of ['missing','invalid'])test(`${failure} source revision preserves the last request`,async t=>{
    const f=await fixture(t);await writeCatalogRebuildRequest({root:f.checkout});const before=await fs.readFile(f.file);
    if(failure==='missing')await fs.unlink(path.join(f.checkout,'revision.txt'));else await fs.writeFile(path.join(f.checkout,'revision.txt'),'unverified revision');
    await assert.rejects(writeCatalogRebuildRequest({root:f.checkout}));assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readdir(path.dirname(f.file)),['current.json']);
});

test('a linked request or shared request inode is refused without changing the linked bytes',async t=>{
    const f=await fixture(t),other=path.join(f.directory,'manual.json');await fs.writeFile(other,'preserve manual bytes');await fs.mkdir(path.dirname(f.file),{recursive:true});
    await fs.symlink(other,f.file);await assert.rejects(writeCatalogRebuildRequest({root:f.checkout}));assert.equal(await fs.readFile(other,'utf8'),'preserve manual bytes');
    await fs.unlink(f.file);await fs.link(other,f.file);await assert.rejects(writeCatalogRebuildRequest({root:f.checkout}));assert.equal(await fs.readFile(other,'utf8'),'preserve manual bytes');
});

test('a linked namespace cannot redirect the rebuild marker outside its checkout',async t=>{
    const f=await fixture(t),outside=path.join(f.directory,'outside');await fs.mkdir(outside);await fs.mkdir(path.join(f.checkout,'.run'));await fs.symlink(outside,path.dirname(f.file));
    await assert.rejects(writeCatalogRebuildRequest({root:f.checkout}));assert.deepEqual(await fs.readdir(outside),[]);
});
