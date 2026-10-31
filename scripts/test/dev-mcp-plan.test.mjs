import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readCheckPlan} from '../dev-mcp/check-plan.mjs';
import {checkPlan} from '../workspace/check-plan.mjs';
import {packages} from '../dev-mcp/constants.mjs';
import {toolDefinitions,toolFlags,expectedToolNames} from '../dev-mcp/tool-catalog.mjs';

async function fixture(t){
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc check plan with spaces ')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    for(const [name,directory]of packages){
        await mkdir(path.join(root,directory),{recursive:true});
        await writeFile(path.join(root,directory,'package.json'),JSON.stringify({scripts:{lint:'fixture','format:check':'fixture',typecheck:'DO_NOT_EXECUTE_SENTINEL',build:'DO_NOT_EXECUTE_SENTINEL',
            ...(['frontend','bridge'].includes(name)?{test:'vitest run PRIVATE_SCRIPT_SENTINEL'}:{})}}));
    }
    return root;
}

test('MCP plan matches scoped CLI phases, exposes no scripts and writes no outputs',async t=>{
    const root=await fixture(t),file=path.join(root,'frontend/package.json'),before=await stat(file);
    const selection={packages:['frontend','bridge'],steps:['test','typecheck']};
    const result=await readCheckPlan(root,selection),cli=checkPlan(root,selection);
    assert.deepEqual(result.steps.map(step=>[step.directory,step.command]),cli.map(step=>[step.directory,'npm run '+step.args[1]]));
    assert.deepEqual(result.steps.map(step=>step.step),['typecheck','typecheck','test','test']);
    assert.equal(result.mode,'plan');assert.equal(result.skipped.length,0);assert.match(result.scope,/Shared contracts/);
    assert.match(result.command,/--package frontend --package bridge/);assert.match(result.effects,/normal dist/);
    assert.doesNotMatch(JSON.stringify(result),/SENTINEL/);assert.equal((await stat(file)).mtimeMs,before.mtimeMs);
    assert.deepEqual((await readdir(root)).sort(),['frontend','mcp','services']);
});

test('missing npm test is explicit in mixed selection and never becomes a successful empty plan',async t=>{
    const root=await fixture(t),result=await readCheckPlan(root,{packages:['frontend','api-gateway'],steps:['test']});
    assert.deepEqual(result.steps.map(step=>step.package),['frontend']);
    assert.equal(result.skipped[0].package,'api-gateway');assert.match(result.skipped[0].reason,/coverage/);
    await assert.rejects(readCheckPlan(root,{packages:['api-gateway'],steps:['test']}),error=>error.code==='EMPTY_CHECK_PLAN');
});

test('default package plan covers only the selected package and all its supported phases',async t=>{
    const root=await fixture(t),result=await readCheckPlan(root,{packages:['frontend']});
    assert.deepEqual(result.steps.map(step=>step.step),['lint','format:check','typecheck','build','test']);
    assert.ok(result.steps.every(step=>step.package==='frontend'));assert.match(result.scope,/agent-kit generation/);
});

test('invalid selectors cannot broaden the plan or introduce commands or destinations',async t=>{
    const root=await fixture(t);
    for(const selection of [{},{packages:[]},{packages:['../frontend']},{packages:['frontend','frontend']},{packages:['frontend'],steps:[]},
        {packages:['frontend'],steps:['test','test']},{packages:['frontend'],steps:['test; curl secret']}])
        await assert.rejects(readCheckPlan(root,selection),error=>error.code==='INVALID_ARGUMENT');
});

test('linked, oversized and malformed manifests fail without exposing their contents',async t=>{
    const root=await fixture(t),file=path.join(root,'frontend/package.json'),sentinel=path.join(root,'private.json');
    await writeFile(sentinel,'PRIVATE_FILE_SENTINEL');await rm(file);await symlink(sentinel,file);
    await assert.rejects(readCheckPlan(root,{packages:['frontend']}),error=>error.code==='UNSAFE_FILE');
    await rm(file);await writeFile(file,' '.repeat(32769));
    await assert.rejects(readCheckPlan(root,{packages:['frontend']}),error=>error.code==='FILE_TOO_LARGE');
    for(const value of ['{ PRIVATE_FILE_SENTINEL','null','{"scripts":{"typecheck":true,"build":"x"}}']){
        await writeFile(file,value);
        await assert.rejects(readCheckPlan(root,{packages:['frontend']}),error=>error.code==='MALFORMED_PACKAGE'&&!error.message.includes('SENTINEL'));
    }
    assert.equal(await readFile(sentinel,'utf8'),'PRIVATE_FILE_SENTINEL');
});

test('developer feature flag controls the new catalogue entry without hiding retained evidence tools',()=>{
    assert.deepEqual(toolDefinitions().map(tool=>tool.name),expectedToolNames);
    const disabled=toolDefinitions(toolFlags({NEUROCENTER_DEV_MCP_CHECK_PLAN:'0'})).map(tool=>tool.name);
    assert.equal(disabled.includes('check_plan'),false);assert.ok(disabled.includes('verification_summary'));
    assert.ok(toolDefinitions(toolFlags({})).some(tool=>tool.name==='check_plan'));
    assert.throws(()=>toolFlags({NEUROCENTER_DEV_MCP_CHECK_PLAN:'false'}),error=>error.code==='INVALID_CONFIGURATION');
});

test('lint-only MCP selection matches CLI without build or test escalation',async t=>{
    const root=await fixture(t),selection={packages:['frontend','bridge'],steps:['lint']};
    const result=await readCheckPlan(root,selection);
    assert.deepEqual(result.steps.map(step=>step.command),['npm run lint','npm run lint']);
    assert.deepEqual(result.steps.map(step=>step.directory),checkPlan(root,selection).map(step=>step.directory));
});

test('format check skips an unconfigured frontend and remains read-only across CLI and MCP',async t=>{
    const root=await fixture(t),file=path.join(root,'frontend/package.json');
    const manifest=JSON.parse(await readFile(file,'utf8'));delete manifest.scripts['format:check'];await writeFile(file,JSON.stringify(manifest));
    const selection={packages:['frontend','bridge'],steps:['format:check']},result=await readCheckPlan(root,selection);
    assert.deepEqual(result.steps.map(step=>step.command),['npm run format:check']);
    assert.deepEqual(result.steps.map(step=>step.directory),checkPlan(root,selection).map(step=>step.directory));
    assert.equal(result.skipped[0].package,'frontend');assert.equal(result.skipped[0].step,'format:check');
    await assert.rejects(readCheckPlan(root,{packages:['bridge'],steps:['format']}),error=>error.code==='INVALID_ARGUMENT');
});
