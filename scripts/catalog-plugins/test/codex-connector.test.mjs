import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecipe} from '../recipe-schema.mjs';
import {builtinRecipes} from '../prepare.mjs';

const source={type:'repository',url:'https://github.com/ghost-raven1/opencode_codex_bridge',commit:'de21db304bef59af6421079c10e8a43404fd09fa',subdirectory:'packages/bridge',entrypoint:'src/plugin.ts'};
const recipe={schemaVersion:1,key:'codex-connector',name:'Codex',kind:'plugin',description:'Local Codex model connector',revision:'0.2.0-pack.1',targets:['darwin-arm64']};

test('prepared Codex model connector is a discoverable pinned plugin recipe',()=>{
    assert.equal(validateRecipe({...recipe,source:{type:'prepared',adapter:'opencode-codex-bridge'}}).kind,'plugin');
    assert.equal(builtinRecipes().find(item=>item.key==='opencode-codex-bridge')?.kind,'plugin');
});
test('pinned Codex repository cannot be mispublished as an MCP server',()=>{
    assert.throws(()=>validateRecipe({...recipe,kind:'mcp',source}),/Codex.*plugin/);
    assert.equal(validateRecipe({...recipe,source}).source.commit,source.commit);
});
