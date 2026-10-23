import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createWatchQueue} from '../workspace/dev-watch-queue.mjs';
import {affectedPackages,watchSnapshot,changedWatchInputs} from '../workspace/dev-watch-plan.mjs';
const catalog=['catalog-service','services/catalog-service','main.js'],gateway=['api-gateway','services/api-gateway','main.js'];
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
test('burst changes coalesce, builds serialize and an edit during compilation is retained',async()=>{
    const first=deferred(),entered=deferred(),builds=[],published=[];let active=0,peak=0;
    const q=createWatchQueue({debounceMs:5,build:async selection=>{peak=Math.max(peak,++active);builds.push(selection.map(([id])=>id));if(builds.length===1){entered.resolve();await first.promise;}active--;return {ok:true};},publish:async(_result,selection)=>published.push(selection.map(([id])=>id))});
    q.enqueue([catalog]);q.enqueue([catalog]);void q.flush();await entered.promise;q.enqueue([gateway]);first.resolve();await delay(40);await q.close();assert.equal(peak,1);assert.deepEqual(builds,[[catalog[0]],[gateway[0],catalog[0]]]);assert.deepEqual(published,[[gateway[0],catalog[0]]]);
});
test('a failed TypeScript build never reaches restart/publish and does not retry without a new edit',async()=>{
    let builds=0,published=0;const states=[];const q=createWatchQueue({debounceMs:5,onState:state=>states.push(state),build:async()=>{builds++;return {ok:false,primaryFailure:{code:'BUILD_FAILED'}};},publish:async()=>published++});q.enqueue([catalog]);await delay(30);assert.equal(builds,1);assert.equal(published,0);assert.equal(states.at(-1).phase,'build-failed');await q.close();
});
test('SOURCE_CHANGED from an unrelated snapshot edit retries the selected packages after debounce',async()=>{
    let builds=0,published=0;const q=createWatchQueue({debounceMs:5,build:async()=>++builds===1?{ok:false,primaryFailure:{code:'SOURCE_CHANGED_AFTER_SNAPSHOT'}}:{ok:true},publish:async()=>published++});q.enqueue([catalog]);await delay(40);await q.close();assert.equal(builds,2);assert.equal(published,1);
});
test('stop aborts the owned build and no late result can restart a service',async()=>{
    const entered=deferred(),released=deferred();let aborted=false,published=false,cleaned=0;const q=createWatchQueue({debounceMs:5,build:async(_selection,signal)=>{signal.addEventListener('abort',()=>{aborted=true;released.resolve();});entered.resolve();await released.promise;return {ok:true};},publish:async()=>published=true,cleanup:async()=>cleaned++});q.enqueue([catalog]);void q.flush();await entered.promise;await q.close();assert.equal(aborted,true);assert.equal(published,false);assert.equal(cleaned,1);
});
test('service inputs rebuild only their package, shared includes consumers and MCP includes Catalog/RAG',()=>{
    assert.deepEqual(affectedPackages(['services/api-gateway/src/main.ts']).map(([id])=>id),['api-gateway']);assert.deepEqual(affectedPackages(['frontend/src/main.tsx']),[]);assert.equal(affectedPackages(['services/shared/contract.cjs']).length,7);assert.deepEqual(new Set(affectedPackages(['mcp/neurocenter-asset-sync/src/index.ts']).map(([id])=>id)),new Set(['bridge','catalog-service','rag-sync-service']));
});
test('bounded polling observes new/deleted source and ignores outputs, dependencies and links',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-watch-input-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const src=path.join(root,'services/catalog-service/src');await fs.mkdir(src,{recursive:true});await fs.writeFile(path.join(src,'main.ts'),'one');await fs.mkdir(path.join(src,'node_modules'));await fs.writeFile(path.join(src,'node_modules/ignore.ts'),'ignored');await fs.symlink(os.tmpdir(),path.join(src,'link'));const before=await watchSnapshot(root);await fs.rm(path.join(src,'main.ts'));await fs.writeFile(path.join(src,'new.ts'),'two');const after=await watchSnapshot(root);assert.deepEqual(changedWatchInputs(before,after).sort(),['services/catalog-service/src/main.ts','services/catalog-service/src/new.ts']);assert.equal([...after.keys()].some(name=>name.includes('node_modules')),false);
});
