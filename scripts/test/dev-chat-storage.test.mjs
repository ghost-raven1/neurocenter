import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareDevChatStorage} from '../workspace/dev-chat-storage.mjs';

const external={CHAT_S3_ENDPOINT:'https://ceph.example.test',CHAT_S3_PROJECT_BUCKET:'project-chat',CHAT_S3_PERSONAL_BUCKET:'personal-chat',
    CHAT_S3_ACCESS_KEY_FILE:'secrets/access',CHAT_S3_SECRET_KEY_FILE:'secrets/secret'};
const proofs=[];
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-chat-startup-')));
    t.after(async()=>{await fs.rm(root,{recursive:true,force:true});proofs.push({root,removed:await fs.lstat(root).then(()=>false,error=>error.code==='ENOENT')});if(process.env.CHAT_STARTUP_TEST_EVIDENCE)await fs.writeFile(process.env.CHAT_STARTUP_TEST_EVIDENCE,JSON.stringify(proofs,null,2)+'\n');});
    return root;
}
function dependencies(){
    const warnings=[],infos=[],calls=[],forbid=name=>()=>{calls.push(name);throw Error('Unexpected '+name);};
    return{warnings,infos,calls,run:forbid('Docker'),fetch:forbid('health request'),probe:forbid('S3 probe'),output:{warning:value=>warnings.push(value),info:(...value)=>infos.push(value)}};
}
async function secrets(root){
    await fs.mkdir(path.join(root,'secrets'));
    await fs.writeFile(path.join(root,'secrets/access'),'test-access',{mode:0o600});await fs.writeFile(path.join(root,'secrets/secret'),'test-secret',{mode:0o600});
}

test('External Ceph stays external, resolves secret paths, and rejects partial configuration',async t=>{
    const root=await fixture(t);await secrets(root);let probed=false;
    const result=await prepareDevChatStorage(root,external,{run(){throw Error('Must not start Docker');},probe:async config=>{assert.equal(config.secretKey,'test-secret');probed=true;}});
    assert.equal(result.CHAT_S3_ACCESS_KEY_FILE,path.join(root,'secrets/access'));assert.ok(probed);assert.equal(result.CHAT_S3_ENDPOINT,external.CHAT_S3_ENDPOINT);
    await assert.rejects(prepareDevChatStorage(root,{CHAT_S3_ENDPOINT:external.CHAT_S3_ENDPOINT}),/CHAT_S3_ACCESS_KEY/);
    await assert.rejects(prepareDevChatStorage(root,{...external,CHAT_S3_ACCESS_KEY:'inline-value'}),/только CHAT_S3_ACCESS_KEY_FILE/);
});

test('Disabled local Ceph never starts MinIO, probes a registry or creates credential files, and reports unavailable attachments',async t=>{
    const root=await fixture(t),deps=dependencies();assert.deepEqual(await prepareDevChatStorage(root,{CHAT_DEV_CEPH:'false'},deps),{});
    assert.deepEqual(deps.calls,[]);assert.deepEqual(await fs.readdir(root),[]);
    assert.equal(deps.warnings.length,1);assert.match(deps.warnings[0],/Ceph.*отключён/);assert.match(deps.warnings[0],/продолж/);assert.match(deps.warnings[0],/вложен/i);
    assert.ok(deps.infos.some(value=>value.join(' ').includes('CHAT_S3_ENDPOINT')));
});

for(const state of ['pair','access-only','secret-only','invalid-pair','symlink'])test('Unconfigured Ceph preserves legacy local keys without reading, completing or replacing them: '+state,async t=>{
    const root=await fixture(t),directory=path.join(root,'.run/chat-storage');await fs.mkdir(directory,{recursive:true,mode:0o700});
    const access=path.join(directory,'access-key'),secret=path.join(directory,'secret-key'),foreign=path.join(root,'foreign-key');
    await fs.writeFile(foreign,'private-foreign-key',{mode:0o600});
    if(state==='symlink')await fs.symlink(foreign,access);
    else if(state!=='secret-only')await fs.writeFile(access,state==='invalid-pair'?'invalid': 'neurocenter-original-access\n',{mode:0o600});
    if(['pair','secret-only','invalid-pair'].includes(state))await fs.writeFile(secret,state==='invalid-pair'?'damaged':'original-secret-with-enough-bytes\n',{mode:0o600});
    const before=await Promise.all([access,secret].map(async file=>{try{const info=await fs.lstat(file);return{ino:info.ino,dev:info.dev,mode:info.mode,bytes:info.isSymbolicLink()?await fs.readlink(file):await fs.readFile(file)};}catch(error){if(error.code==='ENOENT')return null;throw error;}}));
    const deps=dependencies();assert.deepEqual(await prepareDevChatStorage(root,{CHAT_DEV_CEPH:'false',CHAT_DEV_S3_PORT:'NaN'},deps),{});assert.deepEqual(deps.calls,[]);
    const after=await Promise.all([access,secret].map(async file=>{try{const info=await fs.lstat(file);return{ino:info.ino,dev:info.dev,mode:info.mode,bytes:info.isSymbolicLink()?await fs.readlink(file):await fs.readFile(file)};}catch(error){if(error.code==='ENOENT')return null;throw error;}}));
    assert.deepEqual(after,before);assert.equal(await fs.readFile(foreign,'utf8'),'private-foreign-key');assert.ok(!JSON.stringify(deps.warnings).includes('original-secret'));
});

test('An explicitly configured Ceph outage stays a failure without local fallback or credential mutation',async t=>{
    const root=await fixture(t);await secrets(root);const deps=dependencies(),failure=Error('owned external Ceph unavailable');
    const before=await Promise.all(['access','secret'].map(name=>fs.readFile(path.join(root,'secrets',name))));
    await assert.rejects(prepareDevChatStorage(root,external,{...deps,probe:async()=>{throw failure;}}),error=>error===failure);
    assert.deepEqual(deps.warnings,[]);assert.deepEqual(deps.calls,[]);await assert.rejects(fs.lstat(path.join(root,'.run')),{code:'ENOENT'});
    assert.deepEqual(await Promise.all(['access','secret'].map(name=>fs.readFile(path.join(root,'secrets',name)))),before);
});

test('Explicit external credentials still reject unsafe operator files before probing Ceph',async t=>{
    const root=await fixture(t);await secrets(root);const deps=dependencies();
    await fs.chmod(path.join(root,'secrets/secret'),0o644);
    await assert.rejects(prepareDevChatStorage(root,external,deps),/UNSAFE_OPERATOR_FILE/);assert.deepEqual(deps.calls,[]);assert.deepEqual(deps.warnings,[]);
    await fs.chmod(path.join(root,'secrets/secret'),0o600);await fs.rm(path.join(root,'secrets/access'));await fs.symlink(path.join(root,'secrets/secret'),path.join(root,'secrets/access'));
    await assert.rejects(prepareDevChatStorage(root,external,deps));assert.deepEqual(deps.calls,[]);assert.deepEqual(deps.warnings,[]);
});
