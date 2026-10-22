import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const script=await fs.readFile(new URL('../workspace/dev-ceph.sh',import.meta.url),'utf8');
const cleanupProofs=[];
const tools=`#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const argv=process.argv.slice(2),tool=path.basename(process.argv[1]),base=process.env.FAKE_CEPH_FIXTURE;
const root=path.join(base,'data'),mode=process.env.FAKE_CEPH_FAULT||'',events=path.join(base,'events.jsonl');
const event=value=>fs.appendFileSync(events,JSON.stringify({tool,pid:process.pid,...value})+'\\n');
const value=name=>argv[argv.indexOf(name)+1];
const key=file=>{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.entity!==(argv.includes('-n')?value('-n'):'client.admin'))process.exit(96);return data.key;};
const write=(file,data)=>fs.writeFileSync(file,data,{mode:0o600});
const stateFile=path.join(base,'cluster.json');
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{auth:{},user:null};
const save=()=>write(stateFile,JSON.stringify(state));
event({args:argv.map(a=>a.startsWith('--secret-key=')?'--secret-key=<redacted>':a.startsWith('--access-key=')?'--access-key=<redacted>':a)});
if(tool==='ceph-authtool'){
 if(argv.includes('--print-key'))process.stdout.write(key(argv[0])+'\\n');
 else if(argv.includes('--create-keyring'))write(value('--create-keyring'),JSON.stringify({entity:value('-n'),key:'owned-key-'+value('-n')}));
 else if(!argv.includes('--import-keyring'))process.exit(91);
}else if(tool==='monmaptool')write(argv.at(-1),'owned-monmap');
else if((tool==='ceph-mon'||tool==='ceph-osd')&&argv.includes('--mkfs')){
 event({action:'mkfs'});
 if(tool==='ceph-mon'){
  fs.mkdirSync(path.join(root,'mon/store.db'),{recursive:true});write(path.join(root,'mon/store.db/identity'),JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'owner.json'))).fsid));
  if(mode==='mon-mkfs-ack-lost')process.exit(81);
 }else{
  const owner=JSON.parse(fs.readFileSync(path.join(root,'owner.json')));
  const fd=fs.openSync(path.join(root,'osd/block'),'wx',0o600);fs.ftruncateSync(fd,4294967296);fs.closeSync(fd);
  write(path.join(root,'osd/fsid'),owner.osdUuid+'\\n');write(path.join(root,'osd/ceph_fsid'),owner.fsid+'\\n');
  if(mode==='osd-mkfs-ack-lost')process.exit(82);
 }
}else if(['ceph-mon','ceph-mgr','ceph-osd','radosgw'].includes(tool)){
 event({action:'daemon-start'});
 const proc=path.join(base,'proc',String(process.pid));fs.mkdirSync(proc,{recursive:true});write(path.join(proc,'cmdline'),[tool,...argv].join('\\0'));
 let server;const timer=setInterval(()=>{},1000);
 function stop(){event({action:'daemon-stop'});clearInterval(timer);if(server)server.close(()=>process.exit(0));else process.exit(0);}
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 if(tool==='radosgw')server=http.createServer((req,res)=>{event({action:'http',method:req.method,url:req.url});res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');}).listen(Number(process.env.FAKE_CEPH_PORT),'127.0.0.1');
 if(mode==='mgr-exit'&&tool==='ceph-mgr')setTimeout(()=>process.exit(83),300);
}else if(tool==='ceph'){
 const offset=argv.indexOf('-k')+2,args=argv.slice(offset);
 if(args[0]==='status')process.stdout.write(JSON.stringify({fsid:JSON.parse(fs.readFileSync(path.join(root,'owner.json'))).fsid}));
 else if(args[0]==='auth'){
  const entity=args[2];if(!state.auth[entity]){state.auth[entity]='cluster-key-'+entity;save();}write(value('-o'),JSON.stringify({entity,key:state.auth[entity]}));
 }else if(args[0]==='osd'&&args[1]==='new'){
  const registration=JSON.parse(fs.readFileSync(value('-i')));assertSecret(registration.cephx_secret);process.stdout.write('0\\n');
 }else if(args[0]==='osd'&&args[1]==='stat')process.stdout.write('{"num_up_osds":1,"num_in_osds":1}');
 else if(!(args[0]==='osd'&&args[1]==='crush'))process.exit(92);
}else if(tool==='radosgw-admin'){
 if(argv.includes('info')){if(mode==='user-info-error')process.exit(13);if(mode==='user-info-paused'){event({action:'user-info-paused'});while(!fs.existsSync(path.join(base,'release-user-info')))await new Promise(resolve=>setTimeout(resolve,20));}if(!state.user||mode.startsWith('metadata-'))process.exit(22);process.stdout.write(JSON.stringify(state.user));}
 else if(argv.includes('metadata')&&argv.includes('get')){if(mode==='metadata-error')process.exit(13);if(mode==='metadata-existing'||state.user)process.stdout.write(JSON.stringify({key:'user:neurocenter-dev',data:state.user}));else process.exit(2);}
 else if(argv.includes('create')){
  const arg=prefix=>argv.find(a=>a.startsWith(prefix)).slice(prefix.length);
  state.user={user_id:arg('--uid='),keys:[{access_key:arg('--access-key='),secret_key:arg('--secret-key=')}]};save();
  if(mode==='user-create-ack-lost')process.exit(84);process.stdout.write(JSON.stringify(state.user));
 }else process.exit(93);
}else process.exit(94);
function assertSecret(value){if(!value.startsWith('owned-key-osd.0'))process.exit(95);}
`;

async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function exists(file){return fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});}
async function fixture(t){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-dev-ceph-'))),root=path.join(directory,'data'),bin=path.join(directory,'bin'),port=await freePort();
    await fs.mkdir(bin);await fs.mkdir(path.join(directory,'proc'));
    const access=path.join(directory,'access-key'),secret=path.join(directory,'secret-key');
    await fs.writeFile(access,'owned-access-key-123456',{mode:0o600});await fs.writeFile(secret,'owned-secret-key-private-123456789',{mode:0o600});
    await fs.writeFile(path.join(bin,'tool.mjs'),tools,{mode:0o700});
    for(const name of ['ceph','ceph-mon','ceph-mgr','ceph-osd','ceph-authtool','monmaptool','radosgw','radosgw-admin'])await fs.symlink('tool.mjs',path.join(bin,name));
    const source=path.join(directory,'bootstrap.sh');
    // Only fixed filesystem/proc/HTTP roots change in the private copy; all Bash phases execute.
    assert.equal(script.split('readonly ROOT=/var/lib/neurocenter-ceph').length,2);
    await fs.writeFile(source,script.replace('readonly ROOT=/var/lib/neurocenter-ceph','readonly ROOT='+root).replaceAll("'/proc/%d/cmdline'",JSON.stringify(path.join(directory,'proc/%d/cmdline'))).replaceAll('http://127.0.0.1:9000/','http://127.0.0.1:'+port+'/'),{mode:0o700});
    const env={PATH:bin+':'+process.env.PATH,HOME:directory,LANG:'C',CHAT_DEV_S3_ACCESS_KEY_FILE:access,CHAT_DEV_S3_SECRET_KEY_FILE:secret,FAKE_CEPH_FIXTURE:directory,FAKE_CEPH_PORT:String(port)};
    const processes=[];
    const result={directory,root,source,access,secret,env,async events(){return fs.readFile(path.join(directory,'events.jsonl'),'utf8').then(value=>value.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),error=>{if(error.code==='ENOENT')return[];throw error;});},run(extra={}){
        const child=spawn('/bin/bash',[source],{env:{...env,...extra},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal,output})));const record={child,done,output:()=>output};processes.push(record);return record;
    },async health(){const child=spawn('/bin/bash',[source,'--health'],{env,stdio:'ignore'});return await new Promise(resolve=>child.on('exit',code=>resolve(code)));}};
    t.after(async()=>{
        for(const process of processes){if(process.child.exitCode===null&&process.child.signalCode===null)process.child.kill('SIGTERM');await Promise.race([process.done,delay(14000).then(()=>{process.child.kill('SIGKILL');})]);}
        const events=await result.events(),pids=[...new Set([...processes.map(p=>p.child.pid),...events.map(e=>e.pid)])];
        const alive=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}});
        await fs.rm(directory,{recursive:true,force:true});const proof={directory,pids,alive,removed:!await exists(directory)};cleanupProofs.push(proof);
        if(process.env.DEV_CEPH_TEST_EVIDENCE)await fs.writeFile(process.env.DEV_CEPH_TEST_EVIDENCE,JSON.stringify(cleanupProofs,null,2)+'\n');
        assert.deepEqual(alive,[],'All private daemon/control processes exited');
    });
    return result;
}
async function until(check,process,timeout=18000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;if(process&&process.child.exitCode!==null)throw Error('Bootstrap exited: '+process.output());await delay(30);}throw Error('Private fixture deadline: '+process?.output());}
async function ready(f,extra){const process=f.run(extra);await until(()=>exists(path.join(f.root,'ready.json')),process);return process;}
async function stop(process){process.child.kill('SIGTERM');const result=await process.done;assert.equal(result.code,0);return result;}
async function failed(process){const result=await process.done;assert.equal(result.code,1,result.output);assert.doesNotMatch(result.output,/owned-access-key|owned-secret-key/);return result;}
async function identity(f){const files=['owner.json','admin.keyring','mon.keyring','mgr/keyring','osd/keyring','rgw/keyring','osd/fsid','osd/ceph_fsid','ceph.conf'];return Object.fromEntries(await Promise.all(files.map(async name=>[name,await fs.readFile(path.join(f.root,name),'utf8')])));}
const formatted=events=>events.filter(e=>e.action==='mkfs');

test('Compose pins official Ceph and isolates the durable file OSD with the shared port and secret contract',async()=>{
    const compose=await fs.readFile(new URL('../../compose.chat-storage.ceph.dev.yml',import.meta.url),'utf8');
    assert.match(compose,/quay\.io\/ceph\/ceph:v20\.2\.4@sha256:6bb1c8a42fbc0bf87938946990b65174466997bc11c31eb5a323225a779fd8f9/);
    assert.match(compose,/127\.0\.0\.1:\$\{CHAT_DEV_S3_PORT:-19011\}:9000/);assert.doesNotMatch(compose,/CHAT_DEV_CEPH_PORT|privileged:|network_mode:|\/dev\//);
    assert.match(compose,/mem_limit: 3g/);assert.match(compose,/ceph-chat-data:\/var\/lib\/neurocenter-ceph/);assert.match(compose,/cap_drop: \[ALL\]/);assert.match(compose,/cap_add: \[DAC_READ_SEARCH\]/);assert.doesNotMatch(compose,/cap_add:.*DAC_OVERRIDE/);assert.match(compose,/stop_grace_period: 40s/);
    for(const key of ['ACCESS','SECRET'])assert.match(compose,new RegExp('CHAT_DEV_S3_'+key+'_KEY_FILE'));
});
test('First boot formats exactly one MON and one regular 4GiB sparse OSD, enables cephx, and serves a real local RGW readiness request',async t=>{
    const f=await fixture(t),process=await ready(f);assert.equal(await f.health(),0);
    assert.deepEqual(formatted(await f.events()).map(e=>e.tool),['ceph-mon','ceph-osd']);const block=await fs.lstat(path.join(f.root,'osd/block'));assert.ok(block.isFile());assert.equal(block.size,4294967296);assert.ok(block.blocks*512<block.size);
    const config=await fs.readFile(path.join(f.root,'ceph.conf'),'utf8');for(const kind of ['cluster','service','client'])assert.match(config,new RegExp('auth '+kind+' required = cephx'));
    assert.match(config,/osd memory target = 1073741824/);assert.match(config,/bluestore block size = 4294967296/);assert.match(config,/osd pool default size = 1/);
    assert.ok((await f.events()).some(e=>e.action==='http'));assert.doesNotMatch(process.output(),/owned-access-key|owned-secret-key/);await stop(process);assert.equal(await f.health(),1);
});
test('Restart reuses every cluster and S3 identity without mkfs, secret regeneration or user recreation',async t=>{
    const f=await fixture(t);await stop(await ready(f));const before=await identity(f),first=await f.events();await stop(await ready(f));assert.deepEqual(await identity(f),before);
    const after=await f.events();assert.equal(formatted(after).length,2);assert.equal(after.filter(e=>e.tool==='radosgw-admin'&&e.args?.includes('create')).length,1);
    assert.equal(after.filter(e=>e.tool==='ceph-authtool'&&e.args?.includes('--gen-key')).length,first.filter(e=>e.tool==='ceph-authtool'&&e.args?.includes('--gen-key')).length);
});
test('A lost MON mkfs acknowledgement preserves the store and refuses a second format',async t=>{
    const f=await fixture(t);await failed(f.run({FAKE_CEPH_FAULT:'mon-mkfs-ack-lost'}));const before=await fs.readFile(path.join(f.root,'mon/store.db/identity'));await failed(f.run());assert.deepEqual(await fs.readFile(path.join(f.root,'mon/store.db/identity')),before);assert.equal(formatted(await f.events()).length,1);
});
test('A lost OSD mkfs acknowledgement preserves its block identity and refuses a second format',async t=>{
    const f=await fixture(t);await failed(f.run({FAKE_CEPH_FAULT:'osd-mkfs-ack-lost'}));const before=await fs.readFile(path.join(f.root,'osd/fsid'));await failed(f.run());assert.deepEqual(await fs.readFile(path.join(f.root,'osd/fsid')),before);assert.equal(formatted(await f.events()).filter(e=>e.tool==='ceph-osd').length,1);
});
test('An unknown nonempty volume is preserved before identity creation or any Ceph command',async t=>{
    const f=await fixture(t);await fs.mkdir(f.root);await fs.writeFile(path.join(f.root,'foreign-block'),'foreign sentinel');await failed(f.run());assert.equal(await fs.readFile(path.join(f.root,'foreign-block'),'utf8'),'foreign sentinel');assert.equal(await exists(path.join(f.root,'owner.json')),false);assert.deepEqual(await f.events(),[]);
});
test('Changed supplied keys refuse restart before daemon admission and preserve original user and keyrings',async t=>{
    const f=await fixture(t);await stop(await ready(f));const before=await identity(f),events=(await f.events()).length;await fs.writeFile(f.secret,'different-private-secret-123456789');await failed(f.run());assert.deepEqual(await identity(f),before);assert.equal((await f.events()).length,events);
});
test('A symlinked data root never follows or modifies the foreign directory',async t=>{
    const f=await fixture(t),foreign=path.join(f.directory,'foreign');await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,'keep'),'untouched');await fs.symlink(foreign,f.root);await failed(f.run());assert.deepEqual(await fs.readdir(foreign),['keep']);assert.deepEqual(await f.events(),[]);
});
test('A hardlinked secret is rejected before writing an owner or invoking Ceph',async t=>{
    const f=await fixture(t);await fs.link(f.secret,path.join(f.directory,'second-secret-link'));await failed(f.run());assert.equal(await exists(path.join(f.root,'owner.json')),false);assert.deepEqual(await f.events(),[]);
});
test('Missing secret files fail safely without generating replacement credentials',async t=>{
    const f=await fixture(t);await fs.rm(f.secret);await failed(f.run());assert.equal(await exists(f.secret),false);assert.equal(await exists(path.join(f.root,'owner.json')),false);assert.deepEqual(await f.events(),[]);
});
test('Changed daemon configuration is refused before restart without rewriting it',async t=>{
    const f=await fixture(t);await stop(await ready(f));const file=path.join(f.root,'ceph.conf');await fs.appendFile(file,'\nauth client required = none\n');const before=await fs.readFile(file),events=(await f.events()).length;await failed(f.run());assert.deepEqual(await fs.readFile(file),before);assert.equal((await f.events()).length,events);
});
test('A parallel bootstrap cannot enter while the original supervisor owns the volume lock',async t=>{
    const f=await fixture(t),process=await ready(f),before=await identity(f),events=(await f.events()).length;const failure=await failed(f.run());assert.match(failure.output,/another bootstrap/);assert.deepEqual(await identity(f),before);assert.equal((await f.events()).length,events);assert.equal(await f.health(),0);await stop(process);
});
test('A supervised daemon failure stops every remaining owned daemon and clears readiness',async t=>{
    const f=await fixture(t),process=f.run({FAKE_CEPH_FAULT:'mgr-exit'});await failed(process);assert.equal(await exists(path.join(f.root,'ready.json')),false);const started=(await f.events()).filter(e=>e.action==='daemon-start');assert.ok(started.some(e=>e.tool==='ceph-mgr'));for(const event of started)assert.throws(()=>globalThis.process.kill(event.pid,0),{code:'ESRCH'});
});
test('SIGTERM during user preflight and after readiness waits for owned daemons and removes private transient outputs',async t=>{
    const f=await fixture(t),preflight=f.run({FAKE_CEPH_FAULT:'user-info-paused'});await until(async()=>(await f.events()).some(e=>e.action==='user-info-paused'),preflight);
    const stopping=stop(preflight);await delay(60);assert.equal(preflight.child.exitCode,null,'The TERM trap waits for the held foreground preflight');await fs.writeFile(path.join(f.directory,'release-user-info'),'release');await stopping;
    const early=(await f.events()).filter(e=>e.action==='daemon-start');assert.equal(early.length,3);for(const item of early)assert.throws(()=>process.kill(item.pid,0),{code:'ESRCH'});assert.equal(await f.health(),1);
    await stop(await ready(f));const events=await f.events();assert.equal(events.filter(e=>e.action==='daemon-stop').length,7);for(const name of ['ready.json','command.json','auth.tmp','registration.json'])assert.equal(await exists(path.join(f.root,name)),false);assert.equal(await f.health(),1);
});
test('A preexisting RGW user with another secret is refused without replacing or rotating its keys',async t=>{
    const f=await fixture(t);await stop(await ready(f));const file=path.join(f.directory,'cluster.json'),state=JSON.parse(await fs.readFile(file));state.user.keys[0].secret_key='foreign-secret-private-123456789';await fs.writeFile(file,JSON.stringify(state));const before=await fs.readFile(file);await failed(f.run());assert.deepEqual(await fs.readFile(file),before);assert.equal((await f.events()).filter(e=>e.tool==='radosgw-admin'&&e.args?.includes('create')).length,1);
});
test('An RGW metadata read failure is not mistaken for a missing user and never creates credentials',async t=>{
    const f=await fixture(t),failure=await failed(f.run({FAKE_CEPH_FAULT:'user-info-error'}));assert.match(failure.output,/RGW user-info failed \(exit 13\)/);assert.equal((await f.events()).filter(e=>e.tool==='radosgw-admin'&&e.args?.includes('create')).length,0);assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,'cluster.json'))).user,null);
});
test('An ambiguous user-info error with existing exact metadata never overwrites or rotates that user',async t=>{
    const f=await fixture(t),user={user_id:'neurocenter-dev',keys:[{access_key:'foreign-access',secret_key:'foreign-private-secret'}]};await fs.writeFile(path.join(f.directory,'cluster.json'),JSON.stringify({auth:{},user}),{mode:0o600});
    const failure=await failed(f.run({FAKE_CEPH_FAULT:'metadata-existing'}));assert.match(failure.output,/RGW user-absence-proof failed \(exit 0\)/);const events=await f.events();assert.ok(events.some(e=>e.tool==='radosgw-admin'&&e.args?.includes('user:neurocenter-dev')));assert.equal(events.filter(e=>e.tool==='radosgw-admin'&&e.args?.includes('create')).length,0);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'cluster.json'))).user,user);
});
test('An ambiguous user-info error with unreadable exact metadata never assumes absence or creates credentials',async t=>{
    const f=await fixture(t),failure=await failed(f.run({FAKE_CEPH_FAULT:'metadata-error'}));assert.match(failure.output,/RGW user-absence-proof failed \(exit 13\)/);const events=await f.events();assert.ok(events.some(e=>e.tool==='radosgw-admin'&&e.args?.includes('user:neurocenter-dev')));assert.equal(events.filter(e=>e.tool==='radosgw-admin'&&e.args?.includes('create')).length,0);assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,'cluster.json'))).user,null);
});
test('A lost user-create acknowledgement reconciles the exact persisted key pair on retry without recreation',async t=>{
    const f=await fixture(t);await failed(f.run({FAKE_CEPH_FAULT:'user-create-ack-lost'}));const before=await fs.readFile(path.join(f.directory,'cluster.json'));await stop(await ready(f));assert.deepEqual(await fs.readFile(path.join(f.directory,'cluster.json')),before);assert.equal((await f.events()).filter(e=>e.tool==='radosgw-admin'&&e.args?.includes('create')).length,1);
});
test('A missing block in a completed OSD fails closed instead of formatting a replacement',async t=>{
    const f=await fixture(t);await stop(await ready(f));await fs.rm(path.join(f.root,'osd/block'));await failed(f.run());assert.equal(await exists(path.join(f.root,'osd/block')),false);assert.equal(formatted(await f.events()).length,2);
});
test('A linked existing OSD keyring is refused before following or overwriting the foreign file',async t=>{
    const f=await fixture(t);await stop(await ready(f));const file=path.join(f.root,'osd/keyring'),foreign=path.join(f.directory,'foreign-keyring');await fs.rename(file,foreign);const before=await fs.readFile(foreign),events=(await f.events()).length;await fs.symlink(foreign,file);await failed(f.run());assert.deepEqual(await fs.readFile(foreign),before);assert.equal((await f.events()).length,events);
});
