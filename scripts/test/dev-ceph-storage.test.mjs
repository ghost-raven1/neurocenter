import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareDevChatStorage} from '../workspace/dev-chat-storage.mjs';

async function fixture(t,{failure,volume=''}={}) {
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-dev-ceph-'))),calls=[],warnings=[],probes=[];
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const dependencies={output:{warning:message=>warnings.push(message),info(){}},fetch:async()=>({ok:true}),probe:async config=>probes.push(config),
        run(command,args,options){calls.push({command,args,options});if(args[0]==='volume')return{status:0,stdout:typeof volume==='function'?volume(args):volume};
            if(!args.some(arg=>arg.endsWith('/compose.chat-storage.ceph.dev.yml')))return{status:1,stderr:'Unexpected legacy MinIO launch'};
            return failure??{status:0};}};
    return{root,calls,warnings,probes,dependencies,keys:path.join(root,'.run/ceph-chat-storage/credentials')};
}
const contents=async directory=>Object.fromEntries(await Promise.all(['access-key','secret-key'].map(async name=>[name,await fs.readFile(path.join(directory,name),'utf8')])));

test('Default development prepares Ceph RGW with private keys and a distinct loopback identity',async t=>{
    const f=await fixture(t),result=await prepareDevChatStorage(f.root,{},f.dependencies);
    assert.equal(result.CHAT_S3_ENDPOINT,'http://127.0.0.1:19011');assert.equal(f.probes.length,1);
    assert.equal(f.calls.filter(call=>call.args.includes('up')).length,1);
    assert(f.calls.some(call=>call.args.includes(path.join(f.root,'compose.chat-storage.ceph.dev.yml'))));
    const keys=await contents(f.keys);
    for(const [name,value]of Object.entries(keys)){assert(value.trim().length>=16);assert.equal((await fs.stat(path.join(f.keys,name))).mode&0o777,0o600);assert(!f.calls.some(call=>JSON.stringify(call.args).includes(value.trim())));}
    assert.equal(result.CHAT_S3_ACCESS_KEY_FILE,path.join(f.keys,'access-key'));assert.equal(f.warnings.length,0);
});

test('Ceph restart reuses the exact original private pair',async t=>{
    const f=await fixture(t),first=await prepareDevChatStorage(f.root,{},f.dependencies),before=await contents(f.keys);
    const second=await prepareDevChatStorage(f.root,{},f.dependencies);
    assert.deepEqual(second,first);assert.deepEqual(await contents(f.keys),before);assert.equal(f.probes.length,2);
    assert.equal(f.calls.filter(call=>call.args[0]==='volume').length,1);
    assert.deepEqual((await fs.readdir(path.dirname(f.keys))).sort(),['credentials']);
});

for(const [name,failure]of [['unauthorized image',{status:1,stderr:'private registry text must not be copied'}],['timeout',{status:null,error:Object.assign(Error('timeout'),{code:'ETIMEDOUT'})}],['signal',{status:0,signal:'SIGTERM'}]]){
    test(`Unavailable local Ceph (${name}) leaves the application usable and preserves retry identity`,async t=>{
        const f=await fixture(t,{failure}),result=await prepareDevChatStorage(f.root,{},f.dependencies),before=await contents(f.keys);
        assert.deepEqual(result,{});assert.equal(f.probes.length,0);assert(f.warnings.some(message=>/Ceph/.test(message)));
        assert(!f.warnings.join(' ').includes('private registry text'));assert.equal(f.calls.filter(call=>call.args.includes('up')).length,1);
        await prepareDevChatStorage(f.root,{},f.dependencies);assert.deepEqual(await contents(f.keys),before);
    });
}

test('Explicitly disabled local Ceph does not access Docker or legacy keys',async t=>{
    const f=await fixture(t),legacy=path.join(f.root,'.run/chat-storage');await fs.mkdir(legacy,{recursive:true});
    await fs.writeFile(path.join(legacy,'secret-key'),'original MinIO secret');
    assert.deepEqual(await prepareDevChatStorage(f.root,{CHAT_DEV_CEPH:'false'},f.dependencies),{});
    assert.equal(f.calls.length,0);assert.equal(await fs.readFile(path.join(legacy,'secret-key'),'utf8'),'original MinIO secret');
    await assert.rejects(fs.stat(path.dirname(f.keys)),{code:'ENOENT'});
});

test('New Ceph keeps legacy MinIO data paths and credentials untouched',async t=>{
    const f=await fixture(t),legacy=path.join(f.root,'.run/chat-storage');await fs.mkdir(legacy,{recursive:true});
    const saved={'access-key':'neurocenter-original-access\n','secret-key':'original-private-secret\n'};
    for(const [name,bytes]of Object.entries(saved))await fs.writeFile(path.join(legacy,name),bytes,{mode:0o600});
    const result=await prepareDevChatStorage(f.root,{},f.dependencies);assert.equal(result.CHAT_S3_ENDPOINT,'http://127.0.0.1:19011');
    assert.deepEqual(await contents(legacy),saved);assert(f.calls.every(call=>!call.args.join(' ').includes('compose.chat-storage.dev.yml')));
    assert(f.calls.filter(call=>call.args[0]==='volume').every(call=>call.args.join(' ').includes('ceph-chat-data')));
});

test('Missing Ceph identity beside an existing volume never generates replacement keys',async t=>{
    const f=await fixture(t,{volume:args=>args[args.indexOf('--filter')+1].slice('name='.length)+'\n'});
    assert.deepEqual(await prepareDevChatStorage(f.root,{},f.dependencies),{});assert.equal(f.calls.filter(call=>call.args.includes('up')).length,0);
    await assert.rejects(fs.stat(f.keys),{code:'ENOENT'});assert(f.warnings.some(message=>/ключ/i.test(message)));
});

test('A partial Ceph key pair is preserved without starting a different identity',async t=>{
    const f=await fixture(t);await fs.mkdir(f.keys,{recursive:true,mode:0o700});await fs.writeFile(path.join(f.keys,'access-key'),'original-access-key\n',{mode:0o600});
    assert.deepEqual(await prepareDevChatStorage(f.root,{},f.dependencies),{});assert.equal(f.calls.length,0);
    assert.equal(await fs.readFile(path.join(f.keys,'access-key'),'utf8'),'original-access-key\n');await assert.rejects(fs.stat(path.join(f.keys,'secret-key')),{code:'ENOENT'});
});

test('Invalid local Ceph switch and port fail before Docker or credentials',async t=>{
    const f=await fixture(t);
    await assert.rejects(prepareDevChatStorage(f.root,{CHAT_DEV_CEPH:'maybe'},f.dependencies),/CHAT_DEV_CEPH/);
    await assert.rejects(prepareDevChatStorage(f.root,{CHAT_DEV_S3_PORT:'NaN'},f.dependencies),/CHAT_DEV_S3_PORT/);
    assert.equal(f.calls.length,0);await assert.rejects(fs.stat(path.dirname(f.keys)),{code:'ENOENT'});
});

test('Concurrent first preparation publishes one complete Ceph identity and removes losing candidates',async t=>{
    const f=await fixture(t),results=await Promise.all([prepareDevChatStorage(f.root,{},f.dependencies),prepareDevChatStorage(f.root,{},f.dependencies)]);
    assert.deepEqual(results[0],results[1]);assert.equal(f.probes.length,2);
    assert.equal(new Set(f.probes.map(config=>config.secretKey)).size,1);assert.equal(new Set(f.probes.map(config=>config.accessKey)).size,1);
    assert.deepEqual((await fs.readdir(path.dirname(f.keys))).sort(),['credentials']);
});

for(const state of ['public-mode','symlink','hardlink','damaged'])test('Unsafe existing Ceph credentials are preserved and never launched: '+state,async t=>{
    const f=await fixture(t);await fs.mkdir(f.keys,{recursive:true,mode:0o700});
    const outside=path.join(f.root,'private-source');await fs.writeFile(outside,'original-private-value\n',{mode:0o600});
    const access=path.join(f.keys,'access-key'),secret=path.join(f.keys,'secret-key');
    await fs.writeFile(access,'original-access-key\n',{mode:0o600});
    if(state==='symlink')await fs.symlink(outside,secret);
    else if(state==='hardlink')await fs.link(outside,secret);
    else await fs.writeFile(secret,state==='damaged'?'invalid\0key':'original-private-value\n',{mode:state==='public-mode'?0o644:0o600});
    const before=await fs.lstat(secret),bytes=await fs.readFile(secret);
    assert.deepEqual(await prepareDevChatStorage(f.root,{},f.dependencies),{});assert.equal(f.calls.length,0);
    assert.deepEqual(await fs.readFile(secret),bytes);const after=await fs.lstat(secret);assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);
    assert.equal(await fs.readFile(outside,'utf8'),'original-private-value\n');assert(!f.warnings.join(' ').includes('original-private-value'));
});

test('A symlinked runtime state directory is rejected before creating files outside the checkout',async t=>{
    const f=await fixture(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'nc-ceph-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
    await fs.symlink(outside,path.join(f.root,'.run'));
    assert.deepEqual(await prepareDevChatStorage(f.root,{},f.dependencies),{});assert.equal(f.calls.length,0);assert.deepEqual(await fs.readdir(outside),[]);
});

test('Uncertain volume inventory cannot create keys or start Ceph',async t=>{
    const f=await fixture(t);f.dependencies.run=(command,args)=>{f.calls.push({command,args});return{status:1,stderr:'private registry diagnostic'};};
    assert.deepEqual(await prepareDevChatStorage(f.root,{},f.dependencies),{});assert.equal(f.calls.length,1);
    await assert.rejects(fs.stat(f.keys),{code:'ENOENT'});assert(!f.warnings.join(' ').includes('private registry diagnostic'));
});

test('A failed signed bucket privacy probe never exports a partially configured storage',async t=>{
    const f=await fixture(t);f.dependencies.probe=async()=>{throw Error('private diagnostic with credential material');};
    assert.deepEqual(await prepareDevChatStorage(f.root,{},f.dependencies),{});const before=await contents(f.keys);
    assert(f.warnings.some(message=>message.includes('приватность')));assert(!f.warnings.join(' ').includes('credential material'));
    f.dependencies.probe=async config=>f.probes.push(config);assert.equal((await prepareDevChatStorage(f.root,{},f.dependencies)).CHAT_S3_ENDPOINT,'http://127.0.0.1:19011');
    assert.deepEqual(await contents(f.keys),before);
});

test('A local image override requires a digest and is passed only to the Ceph Compose environment',async t=>{
    const f=await fixture(t);await assert.rejects(prepareDevChatStorage(f.root,{CHAT_DEV_CEPH_IMAGE:'registry.example/ceph:latest'},f.dependencies),/CHAT_DEV_CEPH_IMAGE/);
    assert.equal(f.calls.length,0);const image='registry.example/ceph@sha256:'+'a'.repeat(64);
    await prepareDevChatStorage(f.root,{CHAT_DEV_CEPH_IMAGE:image},f.dependencies);
    assert.equal(f.calls.find(call=>call.args.includes('up')).options.env.CHAT_DEV_CEPH_IMAGE,image);
});
