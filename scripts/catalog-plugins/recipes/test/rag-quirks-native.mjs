/** Exercises the actual prepared upstream mutation and central-state modules with owned, observed boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass isolated prepared RAG runtime.');
const runtime = await fs.realpath(path.resolve(process.argv[2]));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-rag-whole-quirks-native-'));
const load = name => import(pathToFileURL(path.join(runtime, name)).href);
const live = { id:'quirk:12345678-1234-1234-1234-123456789abc', content:'Keep previous experience', tags:[], confidence:0.8, lastObserved:'2026-10-29T00:00:00.000Z' };
const line = value => JSON.stringify(value) + '\n';
const cases = [];
let modelCalls = 0, storeWrites = 0, keywordWrites = 0, centralWrites = 0;
try {
    const quirks = await load('upstream/dist/quirks/quirk-store.js');
    const journal = path.join(root, 'quirks.jsonl'), corrupt = line(live) + '{broken}\n';
    await fs.writeFile(journal, corrupt);
    const deps = { storePath:root, cfg:{ embedding:{} }, embedder:{ async embed() { modelCalls++; return [[1,0,0,0]]; } },
        store:{ async addChunks() { storeWrites++; }, async deleteByFilePath() { storeWrites++; }, async getFilePaths() { return []; }, async getChunksByFilePath() { return []; } },
        keywordIndex:{ addChunks() { keywordWrites++; }, removeByFilePath() { keywordWrites++; } } };
    for (const invoke of [() => quirks.addQuirk(deps,{content:'new'}), () => quirks.updateQuirk(deps,live.id,{content:'changed'}),
        () => quirks.removeQuirk(deps,live.id), () => quirks.reconcileQuirks(deps), () => quirks.listQuirks(deps)]) {
        await assert.rejects(invoke); assert.equal(await fs.readFile(journal,'utf8'),corrupt);
        assert.equal(modelCalls,0);assert.equal(storeWrites,0);assert.equal(keywordWrites,0);
    }
    cases.push('Actual add/update/remove/reconcile/read reject the whole corrupt journal before provider or index mutation');
    await fs.writeFile(journal,line(live));
    await assert.rejects(quirks.addQuirk(deps,{content:'new',confidence:'invalid'}));
    await assert.rejects(quirks.updateQuirk(deps,live.id,{content:'changed',confidence:'invalid'}));
    assert.equal(modelCalls,0);assert.equal(storeWrites,0);assert.equal(await fs.readFile(journal,'utf8'),line(live));
    cases.push('Invalid candidate records are rejected before embedding or native writes');
    const { StateSync, mergeQuirkJsonl } = await load('upstream/dist/core/state-sync.js');
    const remote = { async readState(name) { return name==='quirks'?{data:corrupt}:undefined; }, async writeState() { centralWrites++; } };
    const sync = new StateSync({storePath:root,store:remote,config:{vectorStore:{provider:'clickhouse'}},warn() {}});
    await assert.rejects(sync.hydrate());assert.equal(await fs.readFile(journal,'utf8'),line(live));
    await assert.rejects(sync.flush(['quirks']));assert.equal(centralWrites,0);assert.equal(await fs.readFile(journal,'utf8'),line(live));
    await fs.writeFile(sync.versionsPath(),JSON.stringify({quirks:{sha256:createHash('sha256').update(line(live)).digest('hex')}}));
    await assert.rejects(sync.hydrate());assert.equal(await fs.readFile(journal,'utf8'),line(live));
    await fs.unlink(journal);await assert.rejects(sync.hydrate());await assert.rejects(fs.access(journal),{code:'ENOENT'});
    cases.push('Actual StateSync rejects corrupt remote before clean-local adoption, merge, or fallback upload');
    const tombstone={...live,deletedAt:live.lastObserved};
    assert.equal(mergeQuirkJsonl(line(live),line(tombstone)),line(tombstone));
    await fs.writeFile(journal,line(tombstone));assert.deepEqual(await quirks.listQuirks(deps),[]);
    cases.push('A valid tombstone remains in the merged source and is absent from live quirk reads');
    const value={status:'passed',scope:'actual-prepared-upstream-quirks-and-state-sync',runtime,platform:process.platform,architecture:process.arch,
        modelCalls,storeWrites,keywordWrites,centralWrites,cases};
    if(process.argv[3])await fs.writeFile(path.resolve(process.argv[3]),JSON.stringify(value,null,2)+'\n');
    console.log(JSON.stringify({status:value.status,cases:cases.length,modelCalls,storeWrites,keywordWrites,centralWrites}));
} finally { await fs.rm(root,{recursive:true,force:true}); }
