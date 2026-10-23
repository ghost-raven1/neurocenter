import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {createToolAsset,serializeAsset} from '@neurocenter/asset-contract';
import {verifyBuiltRuntime} from '../catalog-plugins/verify-runtime.mjs';
import {RuntimeVerificationScope} from '../catalog-plugins/verify-runtime-process.mjs';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import {toolRuntimePath} from '../catalog-plugins/supply-layout.mjs';
import {codexFixture} from '../catalog-plugins/test/codex-runtime.fixture.mjs';
import {CODEX_CONNECTOR} from '../catalog-plugins/recipes/codex-bridge.mjs';
import codexPin from '../../services/shared/codex-connector-pin.json' with {type:'json'};
const {artifactFixture}=createRequire(import.meta.url)('./runtime-artifact-fixture.cjs');
const target=process.platform==='linux'?`linux-${process.arch}-${process.report.getReport().header.glibcVersionRuntime?'glibc':'musl'}`:`${process.platform}-${process.arch}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const plugin=`export default async input=>{setInterval(()=>{},1000);if(process.send||process.connected)throw new Error('owner IPC leaked');if(!input.client?.app?.log||!(input.serverUrl instanceof URL)||input.project.worktree!==input.directory||input.worktree!==input.directory||typeof input.$!=='function')throw new Error('bad context');return {'chat.message':async()=>{throw new Error('HOOK_MUST_NOT_RUN')}};};`;
const mcp=`import readline from 'node:readline';const methods=[];const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{
const request=JSON.parse(line);methods.push(request.method);let result;
if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}};
else if(request.method==='notifications/initialized')return;
else if(request.method==='tools/list'){if(methods.join(',')!=='initialize,notifications/initialized,tools/list')process.exit(41);result={tools:[{name:'FIXTURE_TOOL_SECRET',description:'FIXTURE_DESCRIPTION_SECRET',inputSchema:{type:'object'}}]};}
else process.exit(42);
if(request.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});`;

async function fixture(t,{kind='plugin',content=plugin,targets=[target],inline=false,entrypoint='runtime/index.mjs'}={}) {
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-runtime-fixture-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const fixtures=inline?[]:targets.map(platform=>artifactFixture([{path:entrypoint,content}],platform));
    const publication={name:'Runtime fixture',kind,description:'Trusted local startup fixture',origin:'npm:fixture',revision:'1.0.0',
        files:inline?[{path:entrypoint,content}]:[],config:{...(kind==='mcp'?{transport:'stdio',args:[],...(inline?{command:'node'}:{})}:{}),
            ...(inline?{entrypoint}:{}),...(fixtures.length?{extra:{runtimeArtifacts:fixtures.map(item=>item.descriptor)}}:{})}};
    const asset=createToolAsset({id:'runtime-fixture',version:'fixture-v1',source:{type:'npm',name:'trusted-runtime-fixture',version:'1.0.0'},license:{spdx:'NOASSERTION'},publication,artifacts:fixtures.map(item=>({descriptor:item.descriptor}))});
    for(const item of fixtures){const archive=path.join(root,toolRuntimePath(item.descriptor.sha256));await fs.mkdir(path.dirname(archive),{recursive:true});await fs.writeFile(archive,item.archive);}
    const filename=path.join(root,'asset.json');await fs.writeFile(filename,serializeAsset(asset));
    return {root,filename,asset,fixtures};
}
function available(t,report) {
    if(report.diagnostics[0]?.code==='isolation-unavailable'){if(process.platform==='darwin')assert.fail(JSON.stringify(report));t.skip(`OS isolation unavailable: ${report.diagnostics[0].message}`);return false;}
    return true;
}

/** Actual prepared adapter and SHA-pinned upstream fixture; no installer, registry, login or model request. */
async function managedCodexFixture(t,{library}={}){
    const built=await codexFixture();t.after(()=>built.close());
    const files=[];
    async function walk(relative=''){
        for(const item of await fs.readdir(path.join(built.directory,relative),{withFileTypes:true})){
            const name=relative?relative+'/'+item.name:item.name;
            if(item.isDirectory())await walk(name);
            else files.push({path:name,content:await fs.readFile(path.join(built.directory,name))});
        }
    }
    await walk();if(library!==undefined)files.find(file=>file.path==='codex-plugin.mjs').content=Buffer.from(library);
    files.sort((a,b)=>(a.path==='codex-plugin.mjs'?-1:b.path==='codex-plugin.mjs'?1:a.path.localeCompare(b.path)));
    const artifact=artifactFixture(files,target),directory=path.join(built.root,'supply');await fs.mkdir(directory);
    const publication={name:'Pinned managed Codex',kind:'plugin',description:'Actual auth-only adapter fixture',origin:codexPin.repository,revision:'fixture-v1',files:[],config:{extra:{codexConnector:CODEX_CONNECTOR,runtimeArtifacts:[artifact.descriptor]}}};
    const asset=createToolAsset({id:'managed-codex-runtime-fixture',version:'fixture-v1',source:{type:'git',repository:codexPin.repository,commit:codexPin.sourceCommit,path:'packages/bridge'},
        license:{spdx:'NOASSERTION'},publication,artifacts:[{descriptor:artifact.descriptor}]});
    const archive=path.join(directory,toolRuntimePath(artifact.descriptor.sha256));await fs.mkdir(path.dirname(archive),{recursive:true});await fs.writeFile(archive,artifact.archive);
    const filename=path.join(directory,'asset.json');await fs.writeFile(filename,serializeAsset(asset));
    return {filename,built,asset};
}

test('managed Codex supply verifies its real owned wrapper without login, permit, subprocess or network',async t=>{
    const f=await managedCodexFixture(t),report=await verifyBuiltRuntime(f.filename);if(!available(t,report))return;
    assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.checks.pluginFactory,true);assert.equal(report.checks.hooks,true);
    assert.deepEqual(report.counts,{tools:0,pluginHooks:2});assert.equal(report.isolation.osEnforced,true);assert.equal(report.isolation.network,'denied');
    if(process.platform==='darwin')assert.equal(report.isolation.childProcesses,'denied');
    assert.doesNotMatch(JSON.stringify(report),/codexbridge-managed|neurocenter-codex-|fixture\.|synthetic-account/);
});

test('managed Codex metadata cannot grant a wrapper to another source or a package without its declaration',async t=>{
    const f=await managedCodexFixture(t),original=structuredClone(f.asset);
    for(const [name,change] of [
        ['another repository',asset=>{asset.source.repository='https://github.com/example/other';}],
        ['another commit',asset=>{asset.source.commit='a'.repeat(40);}],
        ['another source directory',asset=>{asset.source.path='packages/other';}],
        ['an npm source',asset=>{asset.source={type:'npm',name:'untrusted-codex-claim',version:'1.0.0'};}],
        ['missing connector declaration',asset=>{delete asset.card.config.extra.codexConnector;}],
    ])await t.test(name,async child=>{
        const asset=structuredClone(original);change(asset);await fs.writeFile(f.filename,serializeAsset(asset));
        const report=await verifyBuiltRuntime(f.filename);if(!available(child,report))return;
        assert.equal(report.checks.integrity,true,JSON.stringify(report));assert.equal(report.ok,false,JSON.stringify(report));
        assert.equal(report.checks.pluginFactory,false);assert.equal(report.diagnostics[0]?.code,'plugin-initialization-failed');
    });
});

test('malformed Codex metadata fails before running an otherwise valid managed library',async t=>{
    const f=await managedCodexFixture(t);f.asset.card.config.extra.codexConnector.untrusted=true;
    await fs.writeFile(f.filename,serializeAsset(f.asset));const report=await verifyBuiltRuntime(f.filename);
    assert.equal(report.ok,false);assert.equal(report.checks.integrity,false);assert.equal(report.testedTarget,null);
});

test('a trusted source and marker never turn an empty managed factory into a passing smoke',async t=>{
    const f=await managedCodexFixture(t,{library:'export const createManagedCodexPlugin=()=>async()=>({});export default async()=>({});'});
    const report=await verifyBuiltRuntime(f.filename);if(!available(t,report))return;
    assert.equal(report.ok,false);assert.equal(report.checks.pluginFactory,false);assert.equal(report.diagnostics[0]?.code,'plugin-invalid-hooks');
});

test('MCP gate initializes the byte-pinned host artifact and only enumerates tools',async t=>{
    const other=target==='darwin-x64'?'linux-x64-glibc':'darwin-x64',f=await fixture(t,{kind:'mcp',content:mcp,targets:[target,other]});
    const report=await verifyBuiltRuntime(f.filename,{candidateIdentity:'build-uuid:attempt-1'});if(!available(t,report))return;
    assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.status,'passed');assert.equal(report.schemaVersion,1);
    assert.equal(report.candidate.identity,'build-uuid:attempt-1');assert.equal(report.candidate.assetId,'runtime-fixture');assert.equal(report.candidate.version,'fixture-v1');
    assert.equal(report.candidate.manifestSha256,hash(await fs.readFile(f.filename)));assert.match(report.candidate.sourceDigest,/^[a-f0-9]{64}$/);
    assert.equal(report.hostTarget,target);assert.equal(report.testedTarget,target);assert.deepEqual(report.untestedTargets,[other]);
    assert.equal(report.checks.integrity,true);assert.equal(report.checks.initialize,true);assert.equal(report.checks.toolsList,true);assert.equal(report.counts.tools,1);
    assert.equal(report.isolation.osEnforced,true);assert.equal(report.isolation.network,'denied');
    assert.doesNotMatch(JSON.stringify(report),/FIXTURE_TOOL_SECRET|FIXTURE_DESCRIPTION_SECRET/);
});

test('source JS plugin factory receives a disposable SDK context and cannot read/write outside it',async t=>{
    const f=await fixture(t,{inline:true});const canary=path.join(f.root,'personal-profile.txt');await fs.writeFile(canary,'PRIVATE_CANARY');
    const source=`import fs from 'node:fs';${plugin.replace('export default async input=>{',`export default async input=>{if(process.env.PACKAGER_PARENT_SECRET)throw new Error('env leaked');let reads=false,writes=false;try{fs.readFileSync(${JSON.stringify(canary)});reads=true;}catch{}try{fs.writeFileSync(${JSON.stringify(canary)},'changed');writes=true;}catch{}if(reads||writes)throw new Error('sandbox escaped');fs.writeFileSync(process.env.HOME+'/local.txt','own profile');`)};`;
    f.asset.card.files[0].content=source;await fs.writeFile(f.filename,serializeAsset(f.asset));
    const before=process.env.PACKAGER_PARENT_SECRET;process.env.PACKAGER_PARENT_SECRET='PARENT_PROVIDER_CREDENTIAL';
    let report;try{report=await verifyBuiltRuntime(f.filename);}finally{if(before===undefined)delete process.env.PACKAGER_PARENT_SECRET;else process.env.PACKAGER_PARENT_SECRET=before;}
    if(!available(t,report))return;
    assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.checks.pluginFactory,true);assert.equal(report.checks.hooks,true);assert.equal(report.counts.pluginHooks,1);
    assert.equal(await fs.readFile(canary,'utf8'),'PRIVATE_CANARY');assert.doesNotMatch(JSON.stringify(report),/PARENT_PROVIDER_CREDENTIAL|PRIVATE_CANARY/);
});

for(const [name,kind,content,code] of [
    ['invalid MCP protocol','mcp',`process.stdout.write('not-json\\n');setInterval(()=>{},1000);`,'mcp-invalid-protocol'],
    ['crashed MCP','mcp',`process.stderr.write('Authorization: Bearer PACKAGE_SECRET');process.exit(7);`,'runtime-crashed'],
    ['empty MCP tool list','mcp',mcp.replace(`[{name:'FIXTURE_TOOL_SECRET',description:'FIXTURE_DESCRIPTION_SECRET',inputSchema:{type:'object'}}]`,'[]'),'mcp-no-tools'],
    ['invalid MCP tool schema','mcp',mcp.replace("inputSchema:{type:'object'}","inputSchema:{type:'array'}"),'mcp-list-failed'],
    ['invalid plugin descriptor','plugin',`export default {server:async()=>({event:async()=>{}})};`,'plugin-invalid-export'],
    ['plugin without hooks','plugin','export default async()=>({});','plugin-no-hooks'],
    ['invalid plugin hook','plugin',`export default async()=>({'chat.message':'wrong'});`,'plugin-invalid-hooks'],
    ['plugin dependency missing','plugin',`import './missing-dependency.mjs';export default async()=>({});`,'plugin-dependency-missing'],
    ['plugin factory throws','plugin',`export default async()=>{throw new Error('Authorization: Bearer PACKAGE_SECRET')};`,'plugin-initialization-failed'],
])test(`startup gate fails closed: ${name}`,async t=>{
    const f=await fixture(t,{kind,content}),report=await verifyBuiltRuntime(f.filename);if(!available(t,report))return;
    assert.equal(report.ok,false);assert.equal(report.status,'failed');assert.equal(report.diagnostics[0]?.code,code,JSON.stringify(report));
    assert.doesNotMatch(JSON.stringify(report),/PACKAGE_SECRET|Authorization|Bearer/);assert.ok(JSON.stringify(report).length<4096);
});

test('modified archive is rejected before any candidate process starts',async t=>{
    const f=await fixture(t),archive=path.join(f.root,toolRuntimePath(f.fixtures[0].descriptor.sha256));await fs.appendFile(archive,'tampered');
    const report=await verifyBuiltRuntime(f.filename);assert.equal(report.ok,false);assert.equal(report.checks.integrity,false);
    assert.equal(report.testedTarget,null);assert.equal(report.diagnostics[0].code,'integrity-failed');
});

test('foreign target alone never counts as host startup verification',async t=>{
    const other=target==='darwin-x64'?'linux-x64-glibc':'darwin-x64',f=await fixture(t,{targets:[other]});
    const report=await verifyBuiltRuntime(f.filename);assert.equal(report.ok,false);assert.equal(report.testedTarget,null);
    assert.deepEqual(report.untestedTargets,[other]);assert.equal(report.diagnostics[0].code,'no-host-artifact');
});

test('deadline and cancellation stop hung startup and clean owned private profiles',async t=>{
    const f=await fixture(t,{kind:'mcp',content:'setInterval(()=>{},1000);'});
    const before=new Set((await fs.readdir(os.tmpdir())).filter(name=>name.startsWith('neurocenter-package-runtime-')));
    let started=Date.now(),report=await verifyBuiltRuntime(f.filename,{timeoutMs:1500});if(!available(t,report))return;
    assert.equal(report.diagnostics[0].code,'timeout',JSON.stringify(report));assert.ok(Date.now()-started<4000);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1000);started=Date.now();
    try{report=await verifyBuiltRuntime(f.filename,{signal:controller.signal});}finally{clearTimeout(timer);}
    assert.equal(report.status,'cancelled',JSON.stringify(report));assert.ok(Date.now()-started<4000);
    const after=(await fs.readdir(os.tmpdir())).filter(name=>name.startsWith('neurocenter-package-runtime-')&&!before.has(name));assert.deepEqual(after,[]);
});

test('pre-cancelled verification never reads or executes the package',async()=>{
    const controller=new AbortController();controller.abort();const report=await verifyBuiltRuntime('/does/not/exist/asset.json',{signal:controller.signal});
    assert.equal(report.status,'cancelled');assert.equal(report.checks.integrity,false);assert.equal(report.testedTarget,null);
});


test('combined stdout/stderr limit rejects a noisy runtime with bounded diagnostics',async t=>{
    const f=await fixture(t,{kind:'mcp',content:`process.stderr.write('PACKAGE_NOISE_SECRET'.repeat(1000));setInterval(()=>{},1000);`});
    const report=await verifyBuiltRuntime(f.filename,{maxOutputBytes:1024});if(!available(t,report))return;
    assert.equal(report.ok,false);assert.equal(report.diagnostics[0].code,'output-limit',JSON.stringify(report));
    assert.doesNotMatch(JSON.stringify(report),/PACKAGE_NOISE_SECRET/);
});

test('MCP protocol ping is answered without granting server-initiated tool calls',async t=>{
    const source=mcp.replace("const request=JSON.parse(line);methods.push(request.method);", "const request=JSON.parse(line);if(request.id==='server-ping'){if(JSON.stringify(request.result)!=='{}')process.exit(44);return;}methods.push(request.method);")
        .replace("if(request.id!==undefined)process.stdout.write", "if(request.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'server-ping',method:'ping'})+'\\n');if(request.id!==undefined)process.stdout.write");
    const f=await fixture(t,{kind:'mcp',content:source}),report=await verifyBuiltRuntime(f.filename);if(!available(t,report))return;
    assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.counts.tools,1);
});


test('SIGKILL of verifier owner stops a sandbox watcher that ignores stdin EOF',async t=>{
    const source=`process.stdin.resume();process.stdin.on('end',()=>{});process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/watcher-ready'})+'\\n');setInterval(()=>{},1000);`;
    const f=await fixture(t,{kind:'mcp',content:source}),harness=path.join(f.root,'owner.mjs');
    await fs.writeFile(harness,`import {verifyBuiltRuntime} from ${JSON.stringify(new URL('../catalog-plugins/verify-runtime.mjs',import.meta.url).href)};
import {RuntimeVerificationScope} from ${JSON.stringify(new URL('../catalog-plugins/verify-runtime-process.mjs',import.meta.url).href)};
const start=RuntimeVerificationScope.prototype.start;RuntimeVerificationScope.prototype.start=function(command,args,profile,options){const child=start.call(this,command,args,profile,options);
if(args.some(argument=>argument.endsWith('/runtime/index.mjs')))child.stdout.on('data',chunk=>{if(chunk.toString().includes('notifications/watcher-ready'))process.send({ready:true,guardianPid:child.pid,runtimePid:child.runtimePid,root:profile.root});});return child;};
const report=await verifyBuiltRuntime(process.argv[2],{timeoutMs:30000});process.send?.({report});process.disconnect?.();`);
    const owner=spawn(process.execPath,[harness,f.filename],{stdio:['ignore','ignore','ignore','ipc']});let owned;
    const alive=pid=>{
        try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return false;throw error;}
        try{return !/^Z/.test(execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8',timeout:1000,maxBuffer:1024}).trim());}
        catch{return false;}
    };
    t.after(async()=>{owner.kill('SIGKILL');if(owned){try{process.kill(-owned.guardianPid,'SIGKILL');}catch{}await fs.rm(owned.root,{recursive:true,force:true});}});
    const ready=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Watcher startup was not observed')),5000);
        owner.once('error',error=>{clearTimeout(timer);reject(error);});owner.once('exit',()=>{clearTimeout(timer);reject(new Error('Verifier owner exited before watcher startup'));});
        owner.on('message',message=>{if(message?.ready){clearTimeout(timer);resolve(message);}else if(message?.report){clearTimeout(timer);resolve(message);}});
    });
    if(ready.report){if(!available(t,ready.report))return;assert.fail(JSON.stringify(ready.report));}
    owned=ready;assert.ok(Number.isSafeInteger(owned.guardianPid));assert.ok(Number.isSafeInteger(owned.runtimePid));
    assert.equal(alive(owned.runtimePid),true);const exited=new Promise(resolve=>owner.once('exit',resolve));owner.kill('SIGKILL');await exited;
    const deadline=Date.now()+2500;while((alive(owned.guardianPid)||alive(owned.runtimePid))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(alive(owned.guardianPid),false,'Guardian survived verifier owner death');
    assert.equal(alive(owned.runtimePid),false,'Sandbox runtime survived verifier owner death');
});


test('publication env reaches candidate only after trusted guardian and sandbox bootstrap',async t=>{
    const marker='PACKAGE_ENV_AFTER_SANDBOX',content=`if(process.env.PACKAGE_ENV_MARKER!==${JSON.stringify(marker)})process.exit(51);`+mcp;
    const f=await fixture(t,{kind:'mcp',content});f.asset.card.config.env={PACKAGE_ENV_MARKER:marker};await fs.writeFile(f.filename,serializeAsset(f.asset));
    const original=RuntimeVerificationScope.prototype.start,packets=[];
    RuntimeVerificationScope.prototype.start=function(...args){
        const child=original.apply(this,args),send=child.send.bind(child);
        child.send=(message,...rest)=>{if(message.type==='start')packets.push(message);return send(message,...rest);};return child;
    };
    let report;try{report=await verifyBuiltRuntime(f.filename);}finally{RuntimeVerificationScope.prototype.start=original;}
    if(!available(t,report))return;assert.equal(report.ok,true,JSON.stringify(report));assert.ok(packets.length>=2);
    for(const packet of packets){assert.equal(packet.env.PACKAGE_ENV_MARKER,undefined);assert.ok(packet.args.includes(marker)||packet.args.includes('PACKAGE_ENV_MARKER='+marker));}
});


test('slow trusted materialization has its own bound and cannot revive an expired integrity phase',async t=>{
    const f=await fixture(t,{kind:'mcp',content:mcp}),inspect=runtime.inspectRuntimeArchive,start=RuntimeVerificationScope.prototype.start;let starts=0;
    runtime.inspectRuntimeArchive=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,400));return inspect(...args);};
    RuntimeVerificationScope.prototype.start=function(...args){starts++;return start.apply(this,args);};
    let accepted,expired;const began=Date.now();
    try{
        accepted=await verifyBuiltRuntime(f.filename,{timeoutMs:300,integrityTimeoutMs:2000});
        starts=0;expired=await verifyBuiltRuntime(f.filename,{timeoutMs:2000,integrityTimeoutMs:100});
    }finally{runtime.inspectRuntimeArchive=inspect;RuntimeVerificationScope.prototype.start=start;}
    if(!available(t,accepted))return;assert.equal(accepted.ok,true,JSON.stringify(accepted));assert.ok(Date.now()-began>=800);
    assert.equal(expired.ok,false);assert.equal(expired.diagnostics[0].code,'timeout');assert.equal(expired.testedTarget,null);assert.equal(starts,0,'An expired integrity budget must never start sandbox or candidate');
});
