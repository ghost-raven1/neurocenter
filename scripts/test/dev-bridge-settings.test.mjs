import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {unlinkSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {test,mock} from 'node:test';
import {bridgeEntryName,bridgeOrigin,bridgeFileSnapshot,assertBridgeSnapshot,writeBridgeFile,restoreBridgeFile,selectedBridgeConfig,installedBridgeSettings,expectedBridgeRegistration,expectedBridgeLauncher,retainBridgeSettings} from '../workspace/dev-bridge-settings.mjs';

const jsonc=createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url))('jsonc-parser');
const site='https://saved.example.test',api='https://api.saved.example.test';
const parsed=bytes=>jsonc.parse(bytes.toString('utf8'));

/** Inject a single filesystem race at the actual read, retaining native pathname or descriptor I/O. */
async function duringRead(file,hook,action){
    const read=fs.readFile,open=fs.open;let called=false;
    const invoke=read=>{if(called)return read();called=true;return hook(read);};
    const r=mock.method(fs,'readFile',(filename,...args)=>filename===file?invoke(()=>read(filename,...args)):read(filename,...args));
    const o=mock.method(fs,'open',async(filename,...args)=>{
        const handle=await open(filename,...args);
        if(filename===file){const read=handle.read;handle.read=(...args)=>invoke(()=>read.apply(handle,args));}
        return handle;
    });
    try{await action();assert.equal(called,true,'The injected filesystem race must actually execute.');}finally{r.mock.restore();o.mock.restore();}
}

/** Private real files only; neither inherited HOME nor a user's OpenCode configuration is read. */
async function fixture(t){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc bridge settings ')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const home=path.join(directory,'home'),install=path.join(home,"bridge's runtime"),config=path.join(home,'xdg/opencode/opencode.jsonc');
    await fs.mkdir(path.dirname(config),{recursive:true});await fs.mkdir(install,{recursive:true});
    const environment={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'xdg'),NEUROCENTER_URL:'https://caller.example.test',NEUROCENTER_API_URL:'https://caller-api.example.test',CALLER_ONLY:'retained'};
    const own={type:'local',enabled:false,command:['old node','old entry'],custom:{keep:true},environment:{NEUROCENTER_URL:site,NEUROCENTER_API_URL:api,NEUROCENTER_BRIDGE_HOME:path.join(home,'custom-state'),CUSTOM_SETTING:'kept'}};
    const text='// saved comment\n'+JSON.stringify({agent:{reviewer:{model:'user/model'}},mcp:{other:{type:'remote',url:'https://other.test'},[bridgeEntryName]:own}},null,2)+'\n';
    await fs.writeFile(config,text,{mode:0o640});
    const marker=path.join(install,'installation.json');
    await fs.writeFile(marker,JSON.stringify({schemaVersion:1,siteUrl:site,apiUrl:api}),{mode:0o600});
    const options={install,home,environment,jsonc};
    const entry=async value=>fs.writeFile(config,JSON.stringify({mcp:{[bridgeEntryName]:value}})+'\n');
    const registration=async()=>{
        const settings=await installedBridgeSettings(options);
        await fs.writeFile(config,expectedBridgeRegistration(settings,jsonc,install));
        return{settings,expected:await bridgeFileSnapshot(config)};
    };
    const retain=(values,withConfigLock=async(_file,action)=>action())=>retainBridgeSettings({...options,...values,withConfigLock});
    return{directory,home,install,config,environment,own,text,marker,options,entry,registration,retain};
}

test('HTTP origins remain exact, including local ports and IPv6',()=>{
    for(const value of [site,'http://localhost:5173','http://127.0.0.1:4000','http://[::1]:5173'])assert.equal(bridgeOrigin(value),value);
});
test('Malformed or non-origin addresses are rejected instead of normalized to another pairing',()=>{
    for(const value of [undefined,null,123,'','https://user:secret@example.test','https://example.test/','https://example.test/path','https://example.test?q=1','https://example.test#x','ftp://example.test','HTTPS://EXAMPLE.TEST','https://example.test\n','x'.repeat(2049)])assert.throws(()=>bridgeOrigin(value));
});
test('A genuinely missing snapshot can be compared until another writer creates its name',async t=>{
    const f=await fixture(t),file=path.join(f.directory,'missing'),snapshot=await bridgeFileSnapshot(file);
    assert.deepEqual(snapshot,{file,bytes:null});await assertBridgeSnapshot(snapshot);
    await fs.writeFile(file,'created by someone else');await assert.rejects(assertBridgeSnapshot(snapshot),/другим процессом/);
});
test('A snapshot retains exact bytes and permissions without sharing the disk buffer',async t=>{
    const f=await fixture(t),snapshot=await bridgeFileSnapshot(f.config);
    assert.equal(snapshot.bytes.toString(),f.text);assert.equal(snapshot.mode,0o640);assert.match(snapshot.sha256,/^[a-f0-9]{64}$/);
    snapshot.bytes.fill(0);assert.equal(await fs.readFile(f.config,'utf8'),f.text);
});
test('Unsafe files and multiply linked settings cannot become rollback receipts',async t=>{
    const f=await fixture(t),link=path.join(f.directory,'link'),hard=path.join(f.directory,'hard'),large=path.join(f.directory,'large');
    await fs.symlink(f.config,link);await fs.link(f.config,hard);await fs.writeFile(large,Buffer.alloc(8*1024**2+1));
    for(const file of [link,hard,f.directory,large])await assert.rejects(bridgeFileSnapshot(file),/Небезопасный файл/);
});
test('Filesystem errors other than missing names remain visible to callers',async t=>{
    const f=await fixture(t);await assert.rejects(bridgeFileSnapshot(path.join(f.config,'child')),{code:'ENOTDIR'});
    await assert.rejects(selectedBridgeConfig(f.home,{XDG_CONFIG_HOME:f.config}),{code:'ENOTDIR'});
});
test('Disappearance after an existing file was observed is an error, never an absent-file receipt',async t=>{
    const f=await fixture(t);
    await duringRead(f.config,async read=>{const bytes=await read();await fs.unlink(f.config);return bytes;},()=>assert.rejects(bridgeFileSnapshot(f.config),{code:'ENOENT'}));
});
test('An observed in-place edit cannot be returned as a stable snapshot',async t=>{
    const f=await fixture(t);
    await duringRead(f.config,async read=>{const bytes=await read();await fs.appendFile(f.config,'// later edit\n');return bytes;},()=>assert.rejects(bridgeFileSnapshot(f.config),/при чтении/));
});
test('A permission change during reading cannot be accepted as an unchanged rollback receipt',async t=>{
    const f=await fixture(t);
    await duringRead(f.config,async read=>{const bytes=await read();await fs.chmod(f.config,0o600);return bytes;},()=>assert.rejects(bridgeFileSnapshot(f.config),/при чтении/));
    assert.equal((await fs.stat(f.config)).mode&0o777,0o600);
});
test('A pathname ABA swap cannot combine the original inode with foreign file bytes',async t=>{
    const f=await fixture(t),original=path.join(f.directory,'original'),foreign=path.join(f.directory,'foreign');await fs.writeFile(foreign,'{"foreign":"secret"}');
    await duringRead(f.config,async read=>{
        await fs.rename(f.config,original);await fs.symlink(foreign,f.config);
        try{return await read();}finally{await fs.unlink(f.config);await fs.rename(original,f.config);}
    },()=>assert.rejects(bridgeFileSnapshot(f.config),/при чтении/));
    assert.equal(await fs.readFile(f.config,'utf8'),f.text);assert.equal(await fs.readFile(foreign,'utf8'),'{"foreign":"secret"}');
});
test('Growth after the initial stat rejects without an unbounded pathname allocation',async t=>{
    const f=await fixture(t),lstat=fs.lstat,read=fs.readFile,maximum=8*1024**2;let statted=false,unboundedRead=0;
    const l=mock.method(fs,'lstat',async(file,...args)=>{const info=await lstat(file,...args);if(file===f.config&&!statted){statted=true;await fs.truncate(file,maximum+4096);}return info;});
    const r=mock.method(fs,'readFile',async(file,...args)=>{const bytes=await read(file,...args);if(file===f.config)unboundedRead=Math.max(unboundedRead,bytes.length);return bytes;});
    try{await assert.rejects(bridgeFileSnapshot(f.config),/при чтении/);assert.ok(unboundedRead<=maximum+1,'Actual pathname read allocated '+unboundedRead+' bytes despite the limit.');}finally{l.mock.restore();r.mock.restore();}
});
test('A leaf symlink introduced before open cannot be followed to foreign settings',async t=>{
    const f=await fixture(t),original=path.join(f.directory,'original'),foreign=path.join(f.directory,'foreign'),open=fs.open;await fs.writeFile(foreign,'foreign');let swapped=false;
    const stub=mock.method(fs,'open',async(file,...args)=>{if(file===f.config&&!swapped){swapped=true;await fs.rename(file,original);await fs.symlink(foreign,file);}return open(file,...args);});
    try{await assert.rejects(bridgeFileSnapshot(f.config));assert.equal(swapped,true);}finally{stub.mock.restore();}
    assert.equal(await fs.readFile(original,'utf8'),f.text);assert.equal(await fs.readFile(foreign,'utf8'),'foreign');
});
test('Replacing a file by a different inode before open rejects and closes that descriptor',async t=>{
    const f=await fixture(t),original=path.join(f.directory,'original'),open=fs.open;let closed=0;
    const stub=mock.method(fs,'open',async(file,...args)=>{
        if(file===f.config){await fs.rename(file,original);await fs.writeFile(file,'foreign bytes');}
        const handle=await open(file,...args),close=handle.close;
        handle.close=async()=>{closed++;return close.call(handle);};return handle;
    });
    try{await assert.rejects(bridgeFileSnapshot(f.config),/при чтении/);assert.equal(closed,1);}finally{stub.mock.restore();}
    assert.equal(await fs.readFile(original,'utf8'),f.text);assert.equal(await fs.readFile(f.config,'utf8'),'foreign bytes');
});
test('A descriptor read error remains the primary failure and still closes the held file',async t=>{
    const f=await fixture(t),open=fs.open;let closed=0;
    const stub=mock.method(fs,'open',async(file,...args)=>{const handle=await open(file,...args);if(file===f.config){const close=handle.close;handle.read=async()=>{throw Object.assign(Error('owned read EIO'),{code:'EIO'});};handle.close=async()=>{closed++;return close.call(handle);};}return handle;});
    try{await assert.rejects(bridgeFileSnapshot(f.config),{code:'EIO'});assert.equal(closed,1);}finally{stub.mock.restore();}
    assert.equal(await fs.readFile(f.config,'utf8'),f.text);
});
test('Growth after the opened stat consumes at most the original length plus one byte',async t=>{
    const f=await fixture(t),initial=Buffer.byteLength(f.text),open=fs.open;let requested=0,closed=0;
    const stub=mock.method(fs,'open',async(file,...args)=>{
        const handle=await open(file,...args);if(file===f.config){const stat=handle.stat,read=handle.read,close=handle.close;let first=true;
            handle.stat=async(...args)=>{const info=await stat.apply(handle,args);if(first){first=false;await fs.truncate(file,8*1024**2+4096);}return info;};
            handle.read=(buffer,offset,length,position)=>{requested+=length;return read.call(handle,buffer,offset,length,position);};handle.close=async()=>{closed++;return close.call(handle);};
        }return handle;
    });
    try{await assert.rejects(bridgeFileSnapshot(f.config),/при чтении/);assert.equal(requested,initial+1);assert.equal(closed,1);}finally{stub.mock.restore();}
});
test('Empty files have an exact empty snapshot rather than a missing-file receipt',async t=>{
    const f=await fixture(t);await fs.writeFile(f.config,'');const snapshot=await bridgeFileSnapshot(f.config);assert.ok(Buffer.isBuffer(snapshot.bytes));assert.equal(snapshot.bytes.length,0);await assertBridgeSnapshot(snapshot);
});
test('Short descriptor reads are accumulated without truncating the saved JSONC bytes',async t=>{
    const f=await fixture(t),open=fs.open;let reads=0;
    const stub=mock.method(fs,'open',async(file,...args)=>{const handle=await open(file,...args);if(file===f.config){const read=handle.read;handle.read=(buffer,offset,length,position)=>{reads++;return read.call(handle,buffer,offset,Math.min(length,7),position);};}return handle;});
    try{assert.equal((await bridgeFileSnapshot(f.config)).bytes.toString(),f.text);assert.ok(reads>10);}finally{stub.mock.restore();}
});
test('CAS rejects a byte-identical replacement with a different file identity',async t=>{
    const f=await fixture(t),snapshot=await bridgeFileSnapshot(f.config),replacement=path.join(f.directory,'replacement');
    await fs.writeFile(replacement,f.text);await fs.rename(replacement,f.config);await assert.rejects(assertBridgeSnapshot(snapshot),/другим процессом/);
});
test('Atomic file write and restoration preserve exact original bytes and permissions',async t=>{
    const f=await fixture(t),original=await bridgeFileSnapshot(f.config);
    await writeBridgeFile(f.config,'replacement',original.mode,original);const written=await bridgeFileSnapshot(f.config);
    await restoreBridgeFile(original,written);assert.equal(await fs.readFile(f.config,'utf8'),f.text);assert.equal((await fs.stat(f.config)).mode&0o777,0o640);
    assert.equal((await fs.readdir(path.dirname(f.config))).some(name=>name.endsWith('.tmp')),false);
});
test('Rollback removes only a newly created file whose publication is still owned',async t=>{
    const f=await fixture(t),file=path.join(f.directory,'new'),original=await bridgeFileSnapshot(file);
    await writeBridgeFile(file,'created');await restoreBridgeFile(original,await bridgeFileSnapshot(file));await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('Concurrent edits survive failed write and failed rollback with no staging leak',async t=>{
    const f=await fixture(t),original=await bridgeFileSnapshot(f.config);await fs.writeFile(f.config,'concurrent user edit');
    await assert.rejects(writeBridgeFile(f.config,'must not publish',0o600,original),/другим процессом/);
    await assert.rejects(restoreBridgeFile(original,original),/другим процессом/);
    assert.equal(await fs.readFile(f.config,'utf8'),'concurrent user edit');assert.deepEqual(await fs.readdir(path.dirname(f.config)),['opencode.jsonc']);
});
test('A user permission-only edit prevents stale write and rollback from widening access again',async t=>{
    const f=await fixture(t),original=await bridgeFileSnapshot(f.config);await fs.chmod(f.config,0o600);
    await assert.rejects(writeBridgeFile(f.config,'must not publish',original.mode,original),/другим процессом/);
    await assert.rejects(restoreBridgeFile(original,original),/другим процессом/);
    assert.equal(await fs.readFile(f.config,'utf8'),f.text);assert.equal((await fs.stat(f.config)).mode&0o777,0o600);assert.deepEqual(await fs.readdir(path.dirname(f.config)),['opencode.jsonc']);
});
test('Config selection prefers JSONC, follows its existing alias, and honors explicit XDG',async t=>{
    const f=await fixture(t),target=path.join(f.directory,'actual.jsonc');await fs.rename(f.config,target);await fs.symlink(target,f.config);
    await fs.writeFile(path.join(path.dirname(f.config),'opencode.json'),'fallback');
    const selected=await selectedBridgeConfig(f.home,f.environment);assert.equal(selected.logical,f.config);assert.equal(selected.snapshot.file,target);assert.equal(selected.snapshot.bytes.toString(),f.text);
});
test('JSON fallback and absent default use the caller home when XDG is unset',async t=>{
    const f=await fixture(t),file=path.join(f.home,'.config/opencode/opencode.json');await fs.mkdir(path.dirname(file),{recursive:true});
    const absent=await selectedBridgeConfig(f.home,{});assert.equal(absent.logical,file);assert.equal(absent.snapshot.bytes,null);
    await fs.writeFile(file,'{}');assert.equal((await selectedBridgeConfig(f.home,{})).snapshot.bytes.toString(),'{}');
});
test('A dangling preferred JSONC alias cannot silently select the JSON fallback',async t=>{
    const f=await fixture(t),fallback=path.join(path.dirname(f.config),'opencode.json');await fs.unlink(f.config);await fs.symlink(path.join(f.directory,'missing-target'),f.config);await fs.writeFile(fallback,'{"untouched":true}\n');
    await assert.rejects(selectedBridgeConfig(f.home,f.environment),{code:'ENOENT'});assert.equal(await fs.readFile(fallback,'utf8'),'{"untouched":true}\n');assert.equal((await fs.lstat(f.config)).isSymbolicLink(),true);
});
test('A selected file disappearing after resolution cannot become an empty configuration',async t=>{
    const f=await fixture(t),resolve=fs.realpath;
    const stub=mock.method(fs,'realpath',async(file,...args)=>{const resolved=await resolve(file,...args);if(file===f.config)await fs.unlink(resolved);return resolved;});
    try{await assert.rejects(selectedBridgeConfig(f.home,f.environment),/исчезла/);}finally{stub.mock.restore();}
});
test('Malformed JSONC, root/mcp schemas and bridge entries reject without modifying any bytes',async t=>{
    const f=await fixture(t);
    for(const text of ['{"mcp":','null','[]','{"mcp":null}','{"mcp":[]}',...['null','[]','"remote"','false'].map(value=>' {"mcp":{"'+bridgeEntryName+'":'+value+'}}')]){
        await fs.writeFile(f.config,text);await assert.rejects(installedBridgeSettings(f.options));assert.equal(await fs.readFile(f.config,'utf8'),text);
    }
});
test('Invalid UTF-8 is rejected before lossy JSONC parsing can rewrite unrelated user data',async t=>{
    const f=await fixture(t),bytes=Buffer.concat([Buffer.from('{"user":"'),Buffer.from([0xff]),Buffer.from('","mcp":{}}')]);await fs.writeFile(f.config,bytes);
    await assert.rejects(installedBridgeSettings(f.options),/кодиров|UTF-8/);assert.deepEqual(await fs.readFile(f.config),bytes);
});
test('Explicit null bridge environment is invalid rather than silently replaced by an empty object',async t=>{
    const f=await fixture(t);await f.entry({...f.own,environment:null});const before=await fs.readFile(f.config);
    await assert.rejects(installedBridgeSettings(f.options),/переменные/);assert.deepEqual(await fs.readFile(f.config),before);
});
test('Non-string and array environments reject before registration',async t=>{
    const f=await fixture(t);for(const environment of [[],false,'text',{NEUROCENTER_URL:123}]){await f.entry({...f.own,environment});await assert.rejects(installedBridgeSettings(f.options),/переменные/);}
});
test('Saved marker identity and custom environment win over caller development URLs without mutating inputs',async t=>{
    const f=await fixture(t),before={...f.environment},settings=await installedBridgeSettings(f.options);
    assert.equal(settings.siteUrl,site);assert.equal(settings.apiUrl,api);assert.equal(settings.environment.NEUROCENTER_BRIDGE_HOME,f.own.environment.NEUROCENTER_BRIDGE_HOME);assert.equal(settings.environment.CUSTOM_SETTING,'kept');assert.equal(settings.environment.CALLER_ONLY,'retained');assert.deepEqual(f.environment,before);
});
test('Marker can recover a missing registration while legacy registration derives its API only when absent',async t=>{
    const f=await fixture(t);await fs.unlink(f.config);let settings=await installedBridgeSettings(f.options);assert.equal(settings.own,undefined);assert.equal(settings.siteUrl,site);
    await fs.unlink(f.marker);await f.entry({...f.own,environment:{NEUROCENTER_URL:site}});settings=await installedBridgeSettings(f.options);assert.equal(settings.apiUrl,site);
    await fs.unlink(f.config);await assert.rejects(installedBridgeSettings(f.options),/адрес/);
});
test('Conflicting or malformed saved marker identities are never replaced by caller defaults',async t=>{
    const f=await fixture(t);for(const marker of ['{',JSON.stringify({schemaVersion:2}),JSON.stringify({schemaVersion:1,siteUrl:site,apiUrl:'https://different.test'}),JSON.stringify({schemaVersion:1,siteUrl:'https://different.test',apiUrl:api}),JSON.stringify({schemaVersion:1,siteUrl:site,apiUrl:site+'/path'})]){
        await fs.writeFile(f.marker,marker);await assert.rejects(installedBridgeSettings(f.options));assert.equal(await fs.readFile(f.marker,'utf8'),marker);assert.equal(await fs.readFile(f.config,'utf8'),f.text);
    }
});
test('Explicit empty saved site or API values reject with a marker and in legacy registrations',async t=>{
    const f=await fixture(t);for(const legacy of [false,true]){
        if(legacy)await fs.unlink(f.marker);
        for(const name of ['NEUROCENTER_URL','NEUROCENTER_API_URL']){await f.entry({...f.own,environment:{...f.own.environment,[name]:''}});const bytes=await fs.readFile(f.config);await assert.rejects(installedBridgeSettings(f.options));assert.deepEqual(await fs.readFile(f.config),bytes);}
    }
});
test('Expected registration preserves comments and unrelated agents with safely separated command arguments',async t=>{
    const f=await fixture(t),settings=await installedBridgeSettings(f.options),text=expectedBridgeRegistration(settings,jsonc,f.install),value=parsed(text),entry=value.mcp[bridgeEntryName];
    assert.ok(text.startsWith('// saved comment'));assert.deepEqual(value.agent,parsed(f.text).agent);assert.deepEqual(value.mcp.other,parsed(f.text).mcp.other);assert.equal(entry.command.length,2);assert.equal(entry.command[1],path.join(f.install,'dist/index.js'));assert.equal(entry.environment.NEUROCENTER_API_URL,api);
    assert.equal(await fs.readFile(f.config,'utf8'),f.text);
});
test('Missing registration text and a shared site/API produce a minimal valid OpenCode entry',async t=>{
    const f=await fixture(t);await fs.unlink(f.config);await fs.writeFile(f.marker,JSON.stringify({schemaVersion:1,siteUrl:site,apiUrl:site}));
    const settings=await installedBridgeSettings(f.options),value=parsed(expectedBridgeRegistration(settings,jsonc,f.install));assert.equal(Object.hasOwn(value.mcp[bridgeEntryName].environment,'NEUROCENTER_API_URL'),false);
});
test('Retain restores explicit disabled state, custom settings and custom state home after fresh init',async t=>{
    const f=await fixture(t),values=await f.registration(),beforeOther=parsed(f.text);let locks=0;
    const after=await f.retain(values,async(file,action)=>{locks++;assert.equal(file,f.config);return action();}),value=parsed(after.bytes),entry=value.mcp[bridgeEntryName];
    assert.equal(locks,1);assert.equal(entry.enabled,false);assert.deepEqual(entry.custom,{keep:true});assert.equal(entry.environment.CUSTOM_SETTING,'kept');assert.equal(entry.environment.NEUROCENTER_BRIDGE_HOME,f.own.environment.NEUROCENTER_BRIDGE_HOME);assert.deepEqual(value.agent,beforeOther.agent);assert.deepEqual(value.mcp.other,beforeOther.mcp.other);assert.equal(after.mode,0o640);
});
test('Retain without an old entry is a no-op with stable inode and exact registration bytes',async t=>{
    const f=await fixture(t);await fs.writeFile(f.config,'{}\n');const values=await f.registration(),before=await bridgeFileSnapshot(f.config),after=await f.retain(values);
    assert.equal(after.ino,before.ino);assert.deepEqual(after.bytes,before.bytes);
});
test('Retain accepts absent optional environment and preserves an explicit shared API origin',async t=>{
    const f=await fixture(t);await f.entry({type:'local',custom:'without environment'});let values=await f.registration(),entry=parsed((await f.retain(values)).bytes).mcp[bridgeEntryName];assert.equal(entry.custom,'without environment');assert.equal(entry.environment.NEUROCENTER_URL,site);
    await fs.writeFile(f.marker,JSON.stringify({schemaVersion:1,siteUrl:site,apiUrl:site}));await f.entry({...f.own,environment:{NEUROCENTER_URL:site,NEUROCENTER_API_URL:site}});values=await f.registration();entry=parsed((await f.retain(values)).bytes).mcp[bridgeEntryName];assert.equal(entry.environment.NEUROCENTER_API_URL,site);
});
test('Retain refuses a vanished or foreign registration before publishing retained settings',async t=>{
    const f=await fixture(t);await fs.unlink(f.config);const settings=await installedBridgeSettings(f.options),file=settings.config.logical,values={settings,expected:settings.config.snapshot};
    await assert.rejects(f.retain(values),/не подтвердил/);
    for(const entry of [{type:'remote',command:[]},{type:'local',command:['wrong']},undefined]){await fs.writeFile(file,JSON.stringify({mcp:{[bridgeEntryName]:entry}}));values.expected=await bridgeFileSnapshot(file);const bytes=await fs.readFile(file);await assert.rejects(f.retain(values),/не совпала/);assert.deepEqual(await fs.readFile(file),bytes);}
});
test('Retain preserves concurrent user bytes when its expected registration snapshot is stale',async t=>{
    const f=await fixture(t),values=await f.registration();await fs.appendFile(f.config,'// concurrent user edit\n');const bytes=await fs.readFile(f.config);
    await assert.rejects(f.retain(values),/другим процессом/);assert.deepEqual(await fs.readFile(f.config),bytes);
});
test('A newly preferred config before retention cannot redirect writes from the original selection',async t=>{
    const f=await fixture(t),json=path.join(path.dirname(f.config),'opencode.json');await fs.rename(f.config,json);const settings=await installedBridgeSettings(f.options);await fs.writeFile(json,expectedBridgeRegistration(settings,jsonc,f.install));const expected=await bridgeFileSnapshot(json);await fs.writeFile(f.config,'{"new":"preferred"}');
    await assert.rejects(f.retain({settings,expected}),/Путь OpenCode изменился/);assert.equal(await fs.readFile(f.config,'utf8'),'{"new":"preferred"}');assert.deepEqual(await fs.readFile(json),expected.bytes);
});
test('Retargeted aliases during config lock wait preserve both candidate targets and the alias',async t=>{
    const f=await fixture(t),first=path.join(f.directory,'first.jsonc'),second=path.join(f.directory,'second.jsonc');await fs.rename(f.config,first);await fs.symlink(first,f.config);const settings=await installedBridgeSettings(f.options);await fs.writeFile(first,expectedBridgeRegistration(settings,jsonc,f.install));const expected=await bridgeFileSnapshot(first);await fs.writeFile(second,'{"foreign":true}');
    await assert.rejects(f.retain({settings,expected},async(_file,action)=>{await fs.unlink(f.config);await fs.symlink(second,f.config);return action();}),/во время блокировки/);
    assert.deepEqual(await fs.readFile(first),expected.bytes);assert.equal(await fs.readFile(second,'utf8'),'{"foreign":true}');assert.equal(await fs.readlink(f.config),second);
});
test('A fresh preferred alias immediately before retention publication prevents any target replacement',async t=>{
    const f=await fixture(t),values=await f.registration(),target=path.join(f.directory,'foreign.jsonc');await fs.writeFile(target,'{"foreign":"untouched"}');const modify=jsonc.modify;let changed=false;
    const proxy={...jsonc,modify:(...args)=>{if(!changed){changed=true;unlinkSync(f.config);symlinkSync(target,f.config);}return modify(...args);}};
    await assert.rejects(f.retain({...values,jsonc:proxy}),/Путь OpenCode/);
    assert.equal(await fs.readFile(target,'utf8'),'{"foreign":"untouched"}');assert.equal(await fs.readlink(f.config),target);
});
test('POSIX launcher quotes installation paths instead of interpreting shell metacharacters',async t=>{
    const f=await fixture(t),launcher=expectedBridgeLauncher(f.install);
    if(process.platform==='win32'){assert.match(launcher,/DisableDelayedExpansion/);assert.match(expectedBridgeLauncher('C:\\100%\\bridge'),/100%%/);}
    else{assert.match(launcher,/'"'"'/);assert.ok(launcher.includes('"$@"'));assert.ok(launcher.endsWith('"$@"\n'));}
});
test('Windows command formatting escapes percent signs and selects node.exe without executing Windows code',async t=>{
    const f=await fixture(t),descriptor=Object.getOwnPropertyDescriptor(process,'platform');
    Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
    try{
        const launcher=expectedBridgeLauncher('C:\\100%\\bridge');assert.match(launcher,/DisableDelayedExpansion/);assert.match(launcher,/100%%/);assert.match(launcher,/node\.exe/);assert.ok(launcher.endsWith('\r\n'));
        const values=await f.registration(),entry=parsed((await f.retain(values)).bytes).mcp[bridgeEntryName];assert.equal(entry.command[0],path.join(f.install,'bin/node.exe'));
    }finally{Object.defineProperty(process,'platform',descriptor);}
});
