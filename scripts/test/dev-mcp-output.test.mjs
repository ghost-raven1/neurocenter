import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiagnostics} from '../dev-mcp/diagnostics.mjs';
import {validateOutput} from '../dev-mcp/output-validation.mjs';
import {outputSchemas} from '../dev-mcp/output-schemas.mjs';
import {packages} from '../dev-mcp/constants.mjs';
import {toolDefinitions,toolFlags,serverVersion} from '../dev-mcp/tool-catalog.mjs';

async function fixture(t){
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc output contracts ')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    await writeFile(path.join(root,'package.json'),JSON.stringify({name:'neurocenter-workspace'}));
    for(const [,folder]of packages){
        await mkdir(path.join(root,folder),{recursive:true});
        await writeFile(path.join(root,folder,'package.json'),JSON.stringify({version:'0.1.0',scripts:{typecheck:'fixture',build:'fixture',test:'vitest run'}}));
    }
    return {root,diagnostics:await createDiagnostics(root)};
}

test('published output contracts cover exactly the enabled catalogue and can all be compiled',()=>{
    const definitions=toolDefinitions();
    assert.deepEqual(definitions.map(tool=>tool.name).sort(),Object.keys(outputSchemas).sort());
    for(const tool of definitions){
        assert.deepEqual(tool.outputSchema,outputSchemas[tool.name]);assert.equal(tool.outputSchema.type,'object');
        assert.throws(()=>validateOutput(tool.name,{}),error=>error.code==='OUTPUT_CONTRACT_MISMATCH');
    }
});

test('real diagnostics preserve an unavailable Git observation without weakening the result contract',async t=>{
    const {diagnostics}=await fixture(t),value={...await diagnostics.workspaceStatus(),developerTools:{version:serverVersion,tools:toolDefinitions().map(tool=>tool.name)}};
    assert.equal(value.git.available,false);assert.equal(validateOutput('workspace_status',value),value);
    for(const change of [v=>delete v.git.available,v=>v.packages[0].version=1,v=>v.developerTools.tools.push(42),v=>v.privatePrompt='NEVER_ECHO_PRIVATE_PROMPT']){
        const bad=structuredClone(value);change(bad);
        assert.throws(()=>validateOutput('workspace_status',bad),error=>error.code==='OUTPUT_CONTRACT_MISMATCH'&&!error.message.includes('PRIVATE_PROMPT'));
    }
});

test('planning and redacted log output satisfy the published structures and reject counter/type drift',async t=>{
    const {root,diagnostics}=await fixture(t),plan=await diagnostics.checkPlan({packages:['frontend'],steps:['typecheck']});
    validateOutput('check_plan',plan);
    assert.throws(()=>validateOutput('check_plan',{...plan,mode:'executed'}),error=>error.code==='OUTPUT_CONTRACT_MISMATCH');
    assert.throws(()=>validateOutput('check_plan',{...plan,steps:[{...plan.steps[0],package:'not-a-package'}]}),error=>error.code==='OUTPUT_CONTRACT_MISMATCH');
    await mkdir(path.join(root,'.run/logs'),{recursive:true});await writeFile(path.join(root,'.run/logs/neurocenter-catalog.log'),'token=PRIVATE_VALUE\nready');
    const log=await diagnostics.serviceLogs('catalog',2);validateOutput('service_logs',log);
    assert.ok(!JSON.stringify(log).includes('PRIVATE_VALUE'));
    assert.throws(()=>validateOutput('service_logs',{...log,lines:101}),error=>error.code==='OUTPUT_CONTRACT_MISMATCH');
    assert.ok(log.details);
    for(const change of [v=>delete v.details.fileModifiedAt,v=>v.details.observedAt='yesterday',v=>v.details.fileBytes=-1,
        v=>v.details.bytesRead=32769,v=>v.details.currentProcessCorrelation.state='owned',v=>v.details.currentProcessCorrelation.pid=123]){
        const invalid=structuredClone(log);change(invalid);
        assert.throws(()=>validateOutput('service_logs',invalid),error=>error.code==='OUTPUT_CONTRACT_MISMATCH');
    }
    const legacy=await (await createDiagnostics(root,{serviceDetailsEnabled:false})).serviceLogs('catalog',2);
    assert.equal(Object.hasOwn(legacy,'details'),false);validateOutput('service_logs',legacy);
});

test('output-schema flag only changes the advertised contract and preserves evidence tools',()=>{
    const disabled=toolDefinitions(toolFlags({NEUROCENTER_DEV_MCP_OUTPUT_SCHEMAS:'0'}));
    assert.ok(disabled.every(tool=>!Object.hasOwn(tool,'outputSchema')));
    assert.ok(disabled.some(tool=>tool.name==='verification_summary'));
    assert.equal(disabled.length,toolDefinitions().length);
    for(const name of ['NEUROCENTER_DEV_MCP_OUTPUT_SCHEMAS','NEUROCENTER_DEV_MCP_SERVICE_DETAILS'])
        assert.throws(()=>toolFlags({[name]:'yes'}),error=>error.code==='INVALID_CONFIGURATION');
    assert.equal(toolFlags({NEUROCENTER_DEV_MCP_SERVICE_DETAILS:'0'}).serviceDetailsEnabled,false);
});
