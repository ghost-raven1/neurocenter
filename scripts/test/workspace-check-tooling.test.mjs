import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {checkPlan,captureCheckPlan,parseCheckOptions} from '../workspace/check-plan.mjs';
import {runCheck} from '../workspace/check.mjs';
import {createDiagnostics} from '../dev-mcp/diagnostics.mjs';
import {validateOutput} from '../dev-mcp/output-validation.mjs';

const source=fileURLToPath(new URL('../workspace/',import.meta.url));
const gate='Инструменты разработки: локальные контракты';
const expectedFiles=[
    'scripts/agent-kit/test/doctor.test.mjs','scripts/agent-kit/test/evals.test.mjs','scripts/agent-kit/test/generate.test.mjs',
    'scripts/agent-kit/test/install-codex.test.mjs','scripts/agent-kit/test/live-evals.test.mjs','scripts/agent-kit/test/live-preflight.test.mjs',
    'scripts/test/workspace-check-options.test.mjs','scripts/test/workspace-check-process.test.mjs','scripts/test/workspace-check-report.test.mjs','scripts/test/workspace-check-source.test.mjs',
    'scripts/test/workspace-check.test.mjs','scripts/test/workspace-check-tooling.test.mjs','scripts/test/dev-mcp-reports.test.mjs',
    'scripts/test/coverage-inventory.test.mjs','scripts/test/coverage-profiles.test.mjs','scripts/test/coverage-completion.test.mjs',
    'scripts/test/coverage-source-inventory.test.mjs','scripts/test/coverage-focused.test.mjs','scripts/test/dev-mcp-coverage.test.mjs',
    'scripts/test/dev-mcp-output.test.mjs','scripts/test/dev-mcp.test.mjs','scripts/test/dev-mcp-plan.test.mjs','scripts/test/dev-mcp-logs.test.mjs',
    'scripts/test/coverage-lifecycle.test.mjs','scripts/test/dev-mcp-coverage-lifecycle.test.mjs',
    'scripts/test/run-manifest.test.mjs','scripts/test/workspace-process-failure.test.mjs',
    'scripts/agent-kit/test/role-contracts.test.mjs','scripts/agent-kit/test/role-evals.test.mjs',
    'scripts/test/qa-cli.test.mjs','scripts/test/qa-postgres.test.mjs','scripts/test/qa-native.test.mjs',
    'scripts/test/dev-mcp-evidence.test.mjs','scripts/test/dev-mcp-request-trace.test.mjs','scripts/test/dev-launch.test.mjs',
    'scripts/test/dev-cli.test.mjs','scripts/test/dev-cwd.test.mjs','scripts/test/dev-stop.test.mjs',
    'scripts/test/coverage-unit-profile.test.mjs',
    'scripts/test/dev-launch-recovery.test.mjs',
    'scripts/test/workspace-impact-plan.test.mjs','scripts/test/dev-processes.test.mjs','scripts/test/dev-snapshots-build.test.mjs','scripts/test/dev-start.test.mjs',
    'scripts/test/dev-watch-prepared-start.test.mjs','scripts/test/dev-watch-start-order.test.mjs','scripts/test/dev-watch-native.test.mjs',
    'scripts/test/dev-watch-queue.test.mjs','scripts/test/dev-watch-root.test.mjs','scripts/test/dev-watch-daemon.test.mjs',
    'scripts/test/docker-build-progress.test.mjs',
].sort();
const exists=file=>fs.access(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
async function put(root,name,content){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);}

/** Real CLI/Node reports run only tiny owned payloads, never the source tests being checked. */
async function fixture(t,{todo=false}={}){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'nc tooling check '))),root=path.join(directory,'checkout'),record=path.join(directory,'executed.jsonl');
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    await put(root,'package.json',JSON.stringify({name:'neurocenter-workspace'}));await put(root,'.gitignore','.run/\n');
    await fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true});
    for(const name of await fs.readdir(source))if(name.endsWith('.mjs'))await fs.copyFile(path.join(source,name),path.join(root,'scripts/workspace',name));
    await fs.copyFile(path.join(source,'check-tooling-tests.json'),path.join(root,'scripts/workspace/check-tooling-tests.json'));
    await put(root,'scripts/agent-kit/generate.mjs',`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(record)},'generator:'+process.argv.slice(2).join(' ')+'\\n');`);
    for(const file of expectedFiles)await put(root,file,`import {test} from 'node:test';import fs from 'node:fs';test(${JSON.stringify(file)},()=>fs.appendFileSync(${JSON.stringify(record)},${JSON.stringify(file+'\n')}));${todo&&file.endsWith('/dev-mcp-logs.test.mjs')?"test.skip('explicit skipped');test.todo('explicit todo');":''}`);
    for(const file of ['scripts/test/coverage-owned-pg-postgres.test.mjs','scripts/test/coverage-runtime.test.mjs','scripts/test/model-chat-http.test.mjs'])await put(root,file,"throw Error('UNSAFE_SUITE_WAS_SELECTED');");
    const npm=path.join(directory,'npm-cli.js');await fs.writeFile(npm,"throw Error('NPM_MUST_NOT_RUN');");
    const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
    git(['init','-q','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']);
    const env={PATH:path.dirname(process.execPath),NODE_BIN:process.execPath,NPM_CLI_JS:npm};
    const run=(args=['--tooling'],extra={})=>spawnSync(process.execPath,[path.join(root,'scripts/workspace/check.mjs'),...args],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:20000});
    const report=async()=>{const names=await fs.readdir(path.join(root,'.run/check'));assert.equal(names.length,1);const relative='.run/check/'+names[0]+'/report.json';return {relative,value:JSON.parse(await fs.readFile(path.join(root,relative),'utf8'))};};
    return {directory,root,record,run,report,env};
}

test('tooling selector is exact, mutually exclusive and does not change ordinary selectors',()=>{
    assert.deepEqual(parseCheckOptions(['--tooling']),{packages:[],steps:[],tooling:true});
    assert.deepEqual(parseCheckOptions(['--package','frontend']),{packages:['frontend'],steps:[]});
    for(const args of [['--tooling','--tooling'],['--tooling','--package','frontend'],['--step','test','--tooling'],['--tooling','--help'],['--tooling=true']])assert.throws(()=>parseCheckOptions(args));
});

test('tooling plan includes only the fixed local profile and binds its list and selected bytes',async t=>{
    const f=await fixture(t),plan=captureCheckPlan(f.root,{packages:[],steps:[],tooling:true});
    assert.deepEqual(plan.steps.map(step=>step.name),['Agent kit: актуальность генерации',gate]);
    assert.ok(plan.steps.every(step=>step.type==='node'&&step.directory==='.'));assert.equal(plan.steps[1].nodeTests,true);
    assert.deepEqual(plan.steps[1].args,['--test','--test-concurrency=1',...expectedFiles]);
    for(const file of [...expectedFiles,'scripts/agent-kit/generate.mjs','scripts/workspace/check-tooling-tests.json'])assert.match(plan.inputs[file],/^[a-f0-9]{64}$/);
    assert.equal(new Set(plan.steps[1].args).size,plan.steps[1].args.length);
});

test('tooling CLI executes generator and real Node gate without npm/Compose/products and retains MCP-compatible source evidence',async t=>{
    const f=await fixture(t),result=f.run();assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
    const {relative,value}=await f.report();assert.deepEqual(value.selection,{packages:[],steps:[],tooling:true});
    assert.deepEqual(value.plannedSteps,['Agent kit: актуальность генерации',gate]);assert.equal(value.source.status,'unchanged');
    assert.equal(value.steps[1].testRunner,'node');assert.deepEqual(value.steps[1].tests,{passed:expectedFiles.length,failed:0,skipped:0,todo:0,cancelled:0});
    const ran=(await fs.readFile(f.record,'utf8')).trim().split('\n');assert.equal(ran[0],'generator:--check');assert.deepEqual(ran.slice(1).sort(),expectedFiles);
    const summary=await (await createDiagnostics(f.root)).verificationSummary(relative);assert.equal(summary.complete,true);assert.equal(summary.requested.tooling,true);
    assert.equal(summary.testCounters.passed,expectedFiles.length);assert.equal(summary.source.currentSourceEquivalent,'unknown');validateOutput('verification_summary',summary);
});

test('tooling Node skip/TODO stays visible and incomplete despite successful CLI',async t=>{
    const f=await fixture(t,{todo:true}),result=f.run();assert.equal(result.status,0,result.stderr);
    const {relative,value}=await f.report();assert.equal(value.steps[1].tests.skipped,1);assert.equal(value.steps[1].tests.todo,1);
    const summary=await (await createDiagnostics(f.root)).verificationSummary(relative);assert.equal(summary.complete,false);assert.equal(summary.status,'incomplete');
    assert.equal(summary.testCounters.skipped,1);assert.equal(summary.testCounters.todo,1);validateOutput('verification_summary',summary);
});

test('Node-only tooling mode does not probe for an installed npm runtime',async t=>{
    const f=await fixture(t),realpath=fsSync.realpathSync;let npmProbes=0;
    fsSync.realpathSync=(file,...args)=>{if(String(file).includes('npm')){npmProbes++;throw Error('NPM_RUNTIME_MUST_NOT_BE_PROBED');}return realpath(file,...args);};
    const sink={write:()=>{}};let result;
    try{result=await runCheck(f.root,{packages:[],steps:[],tooling:true},{environment:f.env,output:sink,errorOutput:sink});}finally{fsSync.realpathSync=realpath;}
    assert.equal(result.success,true);assert.equal(npmProbes,0);
});

test('missing fixed tooling test fails before generator, runtime or report output',async t=>{
    const f=await fixture(t);await fs.unlink(path.join(f.root,expectedFiles[0]));
    const result=f.run();assert.equal(result.status,1);assert.equal(await exists(path.join(f.root,'.run')),false);assert.equal(await exists(f.record),false);
});

test('tooling flag blocks new execution but keeps help and pure plan inspection available',async t=>{
    const f=await fixture(t),result=f.run(['--tooling'],{NEUROCENTER_CHECK_TOOLING:'0',NODE_BIN:'/unavailable/node'});
    assert.equal(result.status,1);assert.match(result.stderr,/NEUROCENTER_CHECK_TOOLING/);assert.equal(await exists(path.join(f.root,'.run')),false);
    assert.deepEqual(checkPlan(f.root,{packages:[],steps:[],tooling:true}).map(step=>step.name),['Agent kit: актуальность генерации',gate]);
    const help=f.run(['--help'],{NEUROCENTER_CHECK_TOOLING:'0',NODE_BIN:'/unavailable/node'});assert.equal(help.status,0);assert.match(help.stdout,/--tooling/);assert.equal(await exists(f.record),false);
});

test('invalid tooling flags fail before runtime or output even without the new selector',async t=>{
    const f=await fixture(t);
    for(const flag of ['false','2','','01']){const result=f.run(['--package','frontend','--step','build'],{NEUROCENTER_CHECK_TOOLING:flag,NODE_BIN:'/unavailable/node'});
        assert.equal(result.status,1);assert.match(result.stderr,/NEUROCENTER_CHECK_TOOLING/);assert.equal(await exists(path.join(f.root,'.run')),false);}
});

test('disabled tooling mode preserves ordinary selected execution',async t=>{
    const f=await fixture(t);await put(f.root,'frontend/package.json',JSON.stringify({scripts:{build:'fixture'}}));
    await fs.writeFile(f.env.NPM_CLI_JS,`require('node:fs').appendFileSync(${JSON.stringify(f.record)},'ordinary-npm\\n');`);
    const result=f.run(['--package','frontend','--step','build'],{NEUROCENTER_CHECK_TOOLING:'0'});assert.equal(result.status,0,result.stderr);
    const {value}=await f.report();assert.deepEqual(value.selection,{packages:['frontend'],steps:['build']});
    assert.deepEqual(value.plannedSteps,['frontend: build']);assert.equal((await fs.readFile(f.record,'utf8')).trim(),'ordinary-npm');
});

test('tooling fixed source rejects symlink paths before starting the generator',async t=>{
    const f=await fixture(t),file=path.join(f.root,expectedFiles[0]),foreign=path.join(f.directory,'foreign.mjs');await fs.writeFile(foreign,'export {};');await fs.unlink(file);await fs.symlink(foreign,file);
    const result=f.run();assert.equal(result.status,1);assert.equal(await exists(f.record),false);assert.equal(await exists(path.join(f.root,'.run')),false);assert.equal(await fs.readFile(foreign,'utf8'),'export {};');
});

test('tooling list rejects duplicates, traversal and a linked parent without creating a report',async t=>{
    for(const bad of [[...expectedFiles,expectedFiles[0]],['scripts/test/../../foreign.test.mjs']]){
        const f=await fixture(t);await fs.writeFile(path.join(f.root,'scripts/workspace/check-tooling-tests.json'),JSON.stringify(bad));
        const result=f.run();assert.equal(result.status,1);assert.equal(await exists(f.record),false);assert.equal(await exists(path.join(f.root,'.run')),false);
    }
    const f=await fixture(t),old=path.join(f.root,'scripts/agent-kit/test'),foreign=path.join(f.directory,'foreign-tests');await fs.rename(old,foreign);await fs.symlink(foreign,old);
    const result=f.run();assert.equal(result.status,1);assert.equal(await exists(f.record),false);assert.equal(await exists(path.join(f.root,'.run')),false);
});

test('oversized tooling list and selected test files fail before any report or command',async t=>{
    for(const [file,bytes]of [['scripts/workspace/check-tooling-tests.json',16385],[expectedFiles[0],1024**2+1]]){
        const f=await fixture(t);await fs.writeFile(path.join(f.root,file),' '.repeat(bytes));const result=f.run();
        assert.equal(result.status,1);assert.equal(await exists(f.record),false);assert.equal(await exists(path.join(f.root,'.run')),false);
    }
});

test('changed fixed list bytes between planning and capture fail before even the generator',async t=>{
    const f=await fixture(t),file=path.join(f.root,'scripts/workspace/check-tooling-tests.json'),open=fs.open;let changed=false;
    fs.open=async(target,...args)=>{if(target===file&&!changed){changed=true;await fs.writeFile(file,JSON.stringify([...expectedFiles].reverse()));}return open(target,...args);};
    const sink={write:()=>{}};let result;
    try{result=await runCheck(f.root,{packages:[],steps:[],tooling:true},{environment:f.env,output:sink,errorOutput:sink});}finally{fs.open=open;}
    assert.equal(changed,true);assert.equal(result.failure.code,'PLAN_SOURCE_CHANGED');assert.deepEqual(result.steps,[]);assert.equal(await exists(f.record),false);
});

test('summary rejects a tooling gate without its explicit scope or with a substituted product step',async t=>{
    const f=await fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);const {relative,value}=await f.report();
    const diagnostics=await createDiagnostics(f.root);
    for(const change of [v=>delete v.selection.tooling,v=>v.selection.packages.push('frontend'),v=>v.plannedSteps[1]='frontend: build',v=>v.selection.tooling=false,
        v=>v.steps[1].testRunner='vitest',v=>v.steps[0].tests={passed:1000,failed:0,skipped:0,todo:0}]){
        const invalid=structuredClone(value);change(invalid);await fs.writeFile(path.join(f.root,relative),JSON.stringify(invalid));
        await assert.rejects(diagnostics.verificationSummary(relative),error=>error.code==='MALFORMED_REPORT');
    }
});
