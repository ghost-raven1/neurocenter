import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Only the acceptance runner supplies this process's temporary HOME, private state and unpacked runtime.
const [mode,content]=process.argv.slice(2),load=relative=>import(pathToFileURL(path.join(content,'dist',relative)).href);
const state=await load('bridge/state.js'),workspace=await load('bridge/workspace.js'),protocol=await load('bridge/protocol.js');
assert.equal(protocol.BRIDGE_VERSION,'0.9.15');assert.ok(protocol.BRIDGE_CAPABILITIES.includes('project-agents-v2'));
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw||'{}');
if(mode==='bootstrap'){
 assert.ok(process.env.NEUROCENTER_BRIDGE_HOME&&process.env.HOME);const profile=await fs.realpath(process.env.HOME),root=await fs.realpath(input.root);
 assert.ok(root.startsWith(path.dirname(profile)+path.sep));
 await state.writeState('credentials',input.credentials);await workspace.setRoot(root);
}else assert.equal(mode,'report');
const report=await workspace.workspaceReport();await state.api('heartbeat',report);
console.log(JSON.stringify({version:protocol.BRIDGE_VERSION,buildId:await protocol.bridgeBuildId(),capabilities:report.capabilities,
 bindings:report.bindings.map(binding=>({projectId:binding.projectId,bindingId:binding.bindingId,instanceId:binding.instanceId,valid:binding.valid}))}));
