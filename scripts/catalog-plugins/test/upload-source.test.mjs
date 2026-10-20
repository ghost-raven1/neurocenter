import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildRecipe} from '../build.mjs';
import {toolSourcePath} from '../supply-layout.mjs';
import {artifactFixture} from '../../test/runtime-artifact-fixture.cjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function executable(){const bytes=Buffer.alloc(64);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x100000c,4);bytes.writeUInt32LE(2,12);bytes.writeUInt32LE(1,16);bytes.writeUInt32LE(24,20);bytes.writeUInt32LE(0x32,32);bytes.writeUInt32LE(24,36);bytes.writeUInt32LE(1,40);return bytes;}
const runtimeSource={type:'runtime',adapter:'native',assets:{'darwin-arm64':{app:{directory:'.',entrypoint:'bin/server'}}}};
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-native-upload-build-')),bytes=artifactFixture([{path:'bin/server',content:executable()},{path:'install.sh',content:'#!/bin/sh\nexit 77\n'}]).archive;await fs.writeFile(path.join(root,'source.upload'),bytes);const recipe={schemaVersion:1,key:'uploaded-native',name:'Uploaded MCP',kind:'mcp',description:'Ready MCP source archive',revision:'source-'+hash(bytes),source:{type:'archive',file:'source.upload',sha256:hash(bytes),bytes:bytes.length,format:'tar.gz',runtimeSource},targets:['darwin-arm64']};return {root,bytes,recipe,dispose:()=>fs.rm(root,{recursive:true,force:true})};}
test('Raw local source is retained byte-for-byte in the same archive source envelope and native delivery 5',async()=>{
 const f=await fixture();try{const output=path.join(f.root,'output');await buildRecipe({recipe:f.recipe,recipePath:path.join(f.root,'recipe.json'),output});const asset=JSON.parse(await fs.readFile(path.join(output,'asset.json')));assert.equal(asset.source.type,'archive');assert.equal(asset.source.sha256,hash(f.bytes));assert.equal(asset.source.bytes,f.bytes.length);assert.deepEqual(await fs.readFile(path.join(output,toolSourcePath(asset.source.sha256))),f.bytes);assert.equal(asset.compatibility.packageFormat,5);assert.equal(asset.delivery.artifacts[0].descriptor.entrypoint,'app/bin/server');}finally{await f.dispose();}
});
test('Changed source SHA, missing executable and unsupported target fail before a successful asset exists',async()=>{
 const f=await fixture();try{await fs.appendFile(path.join(f.root,'source.upload'),'changed');await assert.rejects(buildRecipe({recipe:f.recipe,recipePath:path.join(f.root,'recipe.json'),output:path.join(f.root,'bad')}),/SHA|повреждён/);await assert.rejects(fs.stat(path.join(f.root,'bad','asset.json')));await fs.writeFile(path.join(f.root,'source.upload'),f.bytes);const changed=structuredClone(f.recipe);changed.source.runtimeSource.assets['darwin-arm64'].app.entrypoint='missing';await assert.rejects(buildRecipe({recipe:changed,recipePath:path.join(f.root,'recipe.json'),output:path.join(f.root,'missing')}),/не совпадает/);await assert.rejects(buildRecipe({recipe:{...f.recipe,targets:['darwin-x64']},recipePath:path.join(f.root,'recipe.json'),output:path.join(f.root,'unsupported')}),/неподдерживаемую/);}finally{await f.dispose();}
});
