import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectSourceInventory,reconcileSourceInventory} from '../coverage/source-inventory.mjs';

const adapter='mcp/neurocenter-asset-sync/vendor/ollama-runtime/index.js';

/** Inventory the shipped adapter without importing it or its dependencies. */
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-vendor-inventory-')));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const source='module.exports = require("ollama-ai-provider-v2");\n';
    await fs.mkdir(path.dirname(path.join(root,adapter)),{recursive:true});
    await fs.writeFile(path.join(root,adapter),source);
    return {root,source};
}

test('Shipped Ollama runtime adapter remains in the production inventory',async t=>{
    const {root,source}=await fixture(t);
    const inventory=await collectSourceInventory(root,[adapter]);
    assert.equal(inventory.inventoryComplete,true);
    assert.equal(inventory.files.length,1);
    const [record]=inventory.files;
    assert.equal(record.role,'production');
    assert.equal(record.kind,'native-adapter');
    assert.equal(record.instrumentable,true);
    assert.equal(record.sha256,createHash('sha256').update(source).digest('hex'));
});

test('An adapter missing from the map stays unrepresented without fabricated line counters',async t=>{
    const {root}=await fixture(t);
    const inventory=await collectSourceInventory(root,[adapter]);
    const result=reconcileSourceInventory(inventory,[],root,'vitest-ast-v8');
    assert.deepEqual(result.summary.production,{total:1,represented:0,unrepresented:1,unsupported:0,unavailable:0});
    assert.equal(result.files[0].measurement,'unrepresented');
    assert.equal(result.files[0].lines,undefined);
    assert.equal(result.allProductionSourcesRepresented,false);
});

test('Unreviewed vendor code still requires explicit ownership',async t=>{
    const {root}=await fixture(t);
    const unknown='mcp/neurocenter-asset-sync/vendor/other-runtime/index.js';
    await fs.mkdir(path.dirname(path.join(root,unknown)),{recursive:true});
    await fs.writeFile(path.join(root,unknown),'module.exports = {};\n');
    const inventory=await collectSourceInventory(root,[unknown]);
    assert.equal(inventory.files[0].role,'unclassified');
});
