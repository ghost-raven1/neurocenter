import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {planImpact,verifyImpactCurrent} from '../workspace/impact-plan.mjs';
import {workspacePackages,captureCheckPlan} from '../workspace/check-plan.mjs';

const modulePath=fileURLToPath(new URL('../workspace/impact-plan.mjs',import.meta.url));
const packageId=directory=>directory==='mcp/neurocenter-asset-sync'?'bridge':path.posix.basename(directory);
const all=workspacePackages.map(packageId);

/** Own a tiny checkout with all planner inputs; no package commands or real services run. */
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'nc-impact-plan-')));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const put=async(name,value)=>{await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),value);};
    for(const folder of workspacePackages){
        await put(folder+'/package.json',JSON.stringify({name:packageId(folder),scripts:{lint:'fixture','format:check':'fixture',typecheck:'fixture',build:'fixture',test:'fixture'}}));
        await put(folder+'/src/main.ts','export const original = true;\n');
    }
    for(const folder of ['scripts/test','scripts/catalog-plugins/test','scripts/catalog-plugins/recipes/test','scripts/agent-kit/test'])
        await put(folder+'/contract.test.mjs',"import test from 'node:test';\n");
    await put('package.json','{"name":"fixture"}\n');await put('.gitignore','.run/\nnode_modules/\n');
    const git=args=>execFileSync('/usr/bin/git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],
        {cwd:root,encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
    git(['init','-q','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']);
    return {root,put,git,baseRevision:git(['rev-parse','HEAD'])};
}

test('a frontend source change plans every package check without creating .run or exposing paths',async t=>{
    const f=await fixture(t);await f.put('frontend/src/main.ts','export const changed = true;\n');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.mode,'scoped');assert.deepEqual(result.packages,['frontend']);
    assert.equal(result.sourceFingerprint.status,'known');assert.equal(result.changedPathsCount,1);
    assert.match(result.changedPathsDigest,/^[a-f0-9]{64}$/);
    assert.deepEqual(result.plannedChecks.selection,{packages:['frontend'],steps:[]});
    assert.deepEqual(result.plannedChecks.checks.map(item=>item.check),['lint','format:check','typecheck','build','test']);
    assert.equal(JSON.stringify(result).includes('frontend/src/main.ts'),false);
    assert.equal((await verifyImpactCurrent(f.root,result)).current,true);
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});

test('verified producer/consumer rules include transitive Catalog, bridge and frontend checks',async t=>{
    const f=await fixture(t);await f.put('mcp/neurocenter-asset-sync/src/main.ts','changed');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.mode,'scoped');assert.deepEqual(new Set(result.packages),new Set(['catalog-service','frontend','bridge']));
    assert.ok(result.reasons.some(item=>item.rule==='VERIFIED_CONSUMER'&&item.package==='catalog-service'));
    assert.ok(result.reasons.some(item=>item.rule==='VERIFIED_CONSUMER'&&item.package==='frontend'));
});

test('staged, dirty, deleted and nonignored untracked paths are combined with committed base changes',async t=>{
    const f=await fixture(t);await f.put('frontend/src/main.ts','committed');f.git(['add','frontend']);
    f.git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','next']);
    await f.put('services/api-gateway/src/main.ts','staged');f.git(['add','services/api-gateway']);
    await f.put('services/api-gateway/src/main.ts','export const original = true;\n');
    await fs.rm(path.join(f.root,'services/skills-service/src/main.ts'));
    await f.put('services/oauth2-bridge/test/new.test.ts','new');await f.put('.run/ignored.txt','ignored');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.changedPathsCount,4);assert.equal(result.mode,'scoped');
    assert.deepEqual(new Set(result.packages),new Set(['frontend','api-gateway','skills-service','oauth2-bridge']));
});

for(const [name,rule]of [['services/shared/common.cjs','SHARED_INPUT'],['package.json','GLOBAL_CONFIGURATION'],
    ['scripts/workspace/check-plan.mjs','PLANNER_INPUT'],['unowned/something.ts','UNKNOWN_PATH']])
test(`${name} selects the actual full default check fallback`,async t=>{
    const f=await fixture(t);await f.put(name,name==='package.json'?'{}':'change');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.mode,'fallback');assert.deepEqual(result.packages,all);
    assert.deepEqual(result.plannedChecks.selection,{packages:[],steps:[]});
    assert.ok(result.reasons.some(item=>item.rule===rule));
    assert.ok(result.plannedChecks.checks.some(item=>item.check==='common-contracts'));
    assert.ok(result.plannedChecks.checks.some(item=>item.check==='agent-kit'));
    assert.equal(result.plannedChecks.checks.filter(item=>item.kind==='compose').length,2);
});

test('no changes is conservative full fallback rather than no tests',async t=>{
    const f=await fixture(t),result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.changedPathsCount,0);assert.equal(result.mode,'fallback');
    assert.ok(result.reasons.some(item=>item.rule==='NO_CHANGES'));
    assert.ok(result.plannedChecks.checks.length>24);
});

test('migrations, native and RAG retain additional acceptance outside default check',async t=>{
    const f=await fixture(t);await f.put('services/catalog-service/src/migrations/99-next.sql','SELECT 1;');
    await f.put('mcp/neurocenter-asset-sync/test/rag-native.test.ts','fixture');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.deepEqual(new Set(result.additionalAcceptance.map(item=>item.kind)),new Set(['database-migrations','native-runtime','rag-integration']));
});

test('missing package test scripts remain explicit additional acceptance',async t=>{
    const f=await fixture(t);await f.put('services/oauth2-bridge/package.json','{"scripts":{"build":"fixture","typecheck":"fixture"}}');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.ok(result.additionalAcceptance.some(item=>item.kind==='package-tests-unavailable'&&item.package==='oauth2-bridge'));
    assert.ok(result.plannedChecks.checks.some(item=>item.check==='build'));
});

for(const name of ['source','manifest','discovery'])test(`verify rejects changed ${name} even with the same base revision`,async t=>{
    const f=await fixture(t);await f.put('frontend/src/main.ts','changed');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    if(name==='source')await f.put('frontend/src/main.ts','changed again');
    if(name==='manifest')await f.put('frontend/package.json','{"version":"different","scripts":{"build":"fixture","typecheck":"fixture","test":"fixture"}}');
    if(name==='discovery')await f.put('scripts/test/new.test.mjs',"import test from 'node:test';\n");
    await assert.rejects(verifyImpactCurrent(f.root,result),error=>error.code==='IMPACT_PLAN_STALE');
});

test('unknown source capture falls back explicitly and cannot be verified as current',async t=>{
    const f=await fixture(t);await fs.symlink('main.ts',path.join(f.root,'frontend/src/linked.ts'));
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.mode,'fallback');assert.equal(result.sourceFingerprint.status,'unknown');
    assert.ok(result.reasons.some(item=>item.rule==='SOURCE_UNKNOWN'));
    await assert.rejects(verifyImpactCurrent(f.root,result),error=>error.code==='IMPACT_PLAN_UNVERIFIABLE');
});

test('excluded active configuration retains unknown equivalence even when captures repeat',async t=>{
    const f=await fixture(t);await f.put('.env','PRIVATE_FIXTURE_VALUE=not-returned');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.mode,'fallback');assert.equal(result.sourceFingerprint.status,'unknown');
    assert.equal(result.sourceFingerprint.reason,'SOURCE_EXCLUDED_INPUTS');
    assert.equal(JSON.stringify(result).includes('not-returned'),false);
    await assert.rejects(verifyImpactCurrent(f.root,result),error=>error.code==='IMPACT_PLAN_UNVERIFIABLE');
});

test('a caller cannot narrow a saved plan by changing its packages or checks',async t=>{
    const f=await fixture(t);await f.put('frontend/src/main.ts','changed');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    result.packages=[];result.plannedChecks.checks=[];
    await assert.rejects(verifyImpactCurrent(f.root,result),error=>error.code==='IMPACT_PLAN_STALE');
});

test('external diff and textconv configured by the checkout never execute',async t=>{
    const f=await fixture(t),sentinel=path.join(f.root,'external-ran'),program=path.join(f.root,'external.cjs');
    await f.put('external.cjs','#!/usr/bin/env node\nrequire("node:fs").writeFileSync('+JSON.stringify(sentinel)+',"forbidden");');
    await fs.chmod(program,0o700);
    await f.put('.gitattributes','*.ts diff=fixture\n');
    f.git(['config','diff.external',program]);f.git(['config','diff.fixture.textconv',program]);
    await f.put('frontend/src/main.ts','changed');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.changedPathsStatus,'known');await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
});

for(const location of ['local-clean','worktree-included-clean','local-process'])test(`Git ${location} filter cannot write during read-only impact observation`,async t=>{
    const f=await fixture(t),sentinel=path.join(f.root,'filter-ran'),program=path.join(f.root,'.git/filter.cjs');
    await fs.writeFile(program,'require("node:fs").writeFileSync('+JSON.stringify(sentinel)+',"forbidden");'+
        (location==='local-process'?'process.exit(1);':'process.stdin.pipe(process.stdout);'));
    const command=process.execPath+' '+program;
    if(location==='worktree-included-clean'){
        f.git(['config','extensions.worktreeConfig','true']);
        const include=path.join(f.root,'.git/filter-include');
        await fs.writeFile(include,'[filter "fixture"]\n\tclean = '+command+'\n');
        f.git(['config','--worktree','include.path',include]);
    }else f.git(['config','filter.fixture.'+(location==='local-process'?'process':'clean'),command]);
    await f.put('.gitattributes','*.ts filter=fixture\n');await f.put('frontend/src/main.ts','changed');
    let result,error;
    try{result=await planImpact(f.root,{baseRevision:f.baseRevision});}catch(value){error=value;}
    await assert.rejects(fs.stat(sentinel),{code:'ENOENT'},'No clean/process filter may start, including config worktree/include sources.');
    assert.ifError(error);assert.equal(result.changedPathsStatus,'known');
});

test('planner uses bounded captured bytes when a manifest grows after preflight',async t=>{
    const f=await fixture(t);await f.put('frontend/src/main.ts','changed');
    const target=path.join(f.root,'frontend/package.json'),open=fs.open,readFileSync=fsSync.readFileSync;
    let opens=0,unboundedReads=0,injected=false;
    fs.open=async(filename,...options)=>{
        const handle=await open(filename,...options);
        if(filename===target&&++opens===3){const close=handle.close.bind(handle);handle.close=async()=>{
            await close();injected=true;await fs.writeFile(target,' '.repeat(1024**2+1));
        };}
        return handle;
    };
    fsSync.readFileSync=(filename,...options)=>{
        if(filename===target){unboundedReads++;throw Error('Unbounded manifest reread is forbidden.');}
        return readFileSync(filename,...options);
    };
    try{await assert.rejects(planImpact(f.root,{baseRevision:f.baseRevision}),error=>['IMPACT_SOURCE_CHANGED','IMPACT_INPUT_LIMIT','IMPACT_PLAN_UNAVAILABLE'].includes(error.code));}
    finally{fs.open=open;fsSync.readFileSync=readFileSync;}
    assert.equal(injected,true);assert.equal(unboundedReads,0);
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});

test('cached manifest and discovery adapters reproduce the full planner without filesystem rereads',async t=>{
    const f=await fixture(t),expected=captureCheckPlan(f.root,{}),bytes=new Map(),entries=new Map();
    for(const folder of workspacePackages)bytes.set(folder+'/package.json',await fs.readFile(path.join(f.root,folder,'package.json')));
    for(const directory of ['scripts/test','scripts/catalog-plugins/test','scripts/catalog-plugins/recipes/test','scripts/agent-kit/test']){
        const names=await fs.readdir(path.join(f.root,directory));entries.set(directory,names);
        for(const name of names)bytes.set(directory+'/'+name,await fs.readFile(path.join(f.root,directory,name)));
    }
    const readFileSync=fsSync.readFileSync,readdirSync=fsSync.readdirSync;let rereads=0;
    const deny=(original,filename,...options)=>{if(String(filename).startsWith(f.root)){rereads++;throw Error('No uncached planner read.');}return original(filename,...options);};
    fsSync.readFileSync=(...args)=>deny(readFileSync,...args);fsSync.readdirSync=(...args)=>deny(readdirSync,...args);
    try{assert.deepEqual(captureCheckPlan(f.root,{}, {readFileBytes:name=>bytes.get(name),readDirectory:name=>entries.get(name)}),expected);}
    finally{fsSync.readFileSync=readFileSync;fsSync.readdirSync=readdirSync;}
    assert.equal(rereads,0);
});

test('oversized planner input is rejected without running commands or writing .run',async t=>{
    const f=await fixture(t);await f.put('frontend/package.json',' '.repeat(1024**2+1));
    await assert.rejects(planImpact(f.root,{baseRevision:f.baseRevision}),error=>error.code==='IMPACT_PLAN_UNAVAILABLE');
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});

test('untrusted Git names are never returned and force fallback without following their contents',async t=>{
    const f=await fixture(t);await f.put('frontend/src/untrusted\nname.ts','private');
    const result=await planImpact(f.root,{baseRevision:f.baseRevision});
    assert.equal(result.mode,'fallback');assert.equal(result.sourceFingerprint.status,'unknown');
    assert.equal(JSON.stringify(result).includes('untrusted'),false);
});

test('source changes during capture reject a plan before any output directory is created',async t=>{
    const f=await fixture(t);await f.put('frontend/src/main.ts','changed');
    const target=path.join(f.root,'frontend/src/main.ts'),open=fs.open;let injected=false;
    fs.open=async(filename,...options)=>{
        const handle=await open(filename,...options);
        if(filename===target&&!injected){injected=true;const read=handle.read.bind(handle);handle.read=async(...args)=>{const value=await read(...args);await fs.appendFile(target,'race');return value;};}
        return handle;
    };
    try{await assert.rejects(planImpact(f.root,{baseRevision:f.baseRevision}),error=>error.code==='IMPACT_SOURCE_CHANGED');}
    finally{fs.open=open;}
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});

test('only an exact local commit is accepted; flags and help do not create a run',async t=>{
    const f=await fixture(t);
    for(const baseRevision of ['HEAD','--help','a'.repeat(40),'a'.repeat(64),'abc'])
        await assert.rejects(planImpact(f.root,{baseRevision}),error=>error.code==='IMPACT_INVALID_BASE');
    const environment={...process.env,NEUROCENTER_IMPACT_PLAN:'0'};
    const help=execFileSync(process.execPath,[modulePath,'--help'],{cwd:f.root,env:environment,encoding:'utf8'});
    assert.match(help,/--base/);
    for(const value of ['0','false'])assert.throws(()=>execFileSync(process.execPath,[modulePath,'--base',f.baseRevision],
        {cwd:f.root,env:{...environment,NEUROCENTER_IMPACT_PLAN:value},stdio:'pipe'}));
    const controller=new AbortController();controller.abort();
    await assert.rejects(planImpact(f.root,{baseRevision:f.baseRevision},{signal:controller.signal}),error=>error.code==='IMPACT_CANCELLED');
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});
