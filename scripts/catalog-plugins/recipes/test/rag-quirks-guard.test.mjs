import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readManagedQuirksJsonl, assertManagedQuirksSource, assertManagedQuirksWrite, validateManagedQuirksJsonl } from '../adapters/rag-quirks-guard.mjs';
import { parseQuirksJsonl, supportsLearningQuirks, QUIRKS_SOURCE_SHA256S } from '../../../../services/shared/project-learning-quirks.cjs';
import { readWorkspaceRagConfiguration } from '../adapters/rag-plugin-config.mjs';
const entry = { id:'quirk:12345678-1234-1234-1234-123456789abc', content:'Keep this experience', tags:[], confidence:0.8, lastObserved:'2026-10-29T00:00:00.000Z' };
const line = value => JSON.stringify(value) + '\n';
async function fixture(action) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-rag-quirks-guard-')); try { await action(root); } finally { await fs.rm(root, { recursive:true, force:true }); } }

test('A missing journal remains empty; complete live and tombstone records retain original bytes', () => fixture(async root => {
    const file = path.join(root, 'quirks.jsonl');
    assert.equal(readManagedQuirksJsonl(file), ''); assertManagedQuirksSource(root);
    const raw = line(entry) + line({...entry, id:'quirk:22345678-1234-1234-1234-123456789abc', deletedAt:entry.lastObserved});
    await fs.writeFile(file, raw);
    assert.equal(readManagedQuirksJsonl(file), raw);
    assert.equal(parseQuirksJsonl(raw).records.length, 1);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
}));

test('A corrupt later line, duplicate, invalid tombstone or incomplete UTF-8 blocks the whole source without changing it', () => fixture(async root => {
    const file = path.join(root, 'quirks.jsonl');
    for (const raw of [Buffer.from(line(entry) + '{broken}\n'), Buffer.from(line(entry) + line(entry)), Buffer.from(line({...entry, deletedAt:'broken'})), Buffer.from(line(entry).trimEnd()), Buffer.concat([Buffer.from(line(entry)),Buffer.from([0xff,0x0a])])]) {
        await fs.writeFile(file, raw); assert.throws(() => readManagedQuirksJsonl(file));
        assert.deepEqual(await fs.readFile(file), raw);
    }
}));

test('Symlink and hardlink sources never reach reconciliation', () => fixture(async root => {
    const file=path.join(root,'quirks.jsonl'), other=path.join(root,'original.jsonl'), raw=line(entry);
    await fs.writeFile(other,raw);await fs.symlink(other,file);assert.throws(()=>readManagedQuirksJsonl(file));
    await fs.unlink(file);await fs.link(other,file);assert.throws(()=>readManagedQuirksJsonl(file));
    assert.equal(await fs.readFile(other,'utf8'),raw);
}));

test('Reviewed old and new source markers remain readable while an unknown source is rejected', () => {
    const pkg=sourceSha256=>({schemaVersion:5,plugin:{kind:'plugin'},config:{extra:{learningQuirks:{schemaVersion:1,format:'opencode-rag-quirks-jsonl',sourceSha256}}}});
    assert.equal(QUIRKS_SOURCE_SHA256S.length,2);
    for(const sha of QUIRKS_SOURCE_SHA256S)assert.equal(supportsLearningQuirks(pkg(sha)),true);
    assert.equal(supportsLearningQuirks(pkg('a'.repeat(64))),false);
});

test('An invalid new quirk and a full journal are rejected before callers mutate their index', () => fixture(async root => {
    const file=path.join(root,'quirks.jsonl'),raw=line(entry);await fs.writeFile(file,raw);
    assert.throws(()=>assertManagedQuirksWrite(root,{...entry,confidence:'invalid'}));
    assert.throws(()=>validateManagedQuirksJsonl('{broken}\n'),error=>error.code==='RAG_QUIRKS_INVALID');
    const records=Array.from({length:1000},(_,index)=>({...entry,id:`quirk:${index.toString(16).padStart(8,'0')}-1234-1234-1234-123456789abc`}));
    const full=records.map(line).join('');await fs.writeFile(file,full);
    assert.throws(()=>assertManagedQuirksWrite(root,entry),/квот/);
    assert.equal(await fs.readFile(file,'utf8'),full);
}));

test('Raw global defaults and explicit project overrides preserve keys, false values and original files', () => fixture(async root => {
    const global=path.join(root,'global.json'),workspace=path.join(root,'workspace.json');
    const base=JSON.stringify({embedding:{model:'global-model',apiKey:'fixture-secret'},openCode:{autoIndex:{enabled:true}},description:{enabled:false}});
    const own=JSON.stringify({embedding:{baseUrl:'http://127.0.0.1:1234/v1'},openCode:{autoIndex:{enabled:false}}});
    await fs.writeFile(global,base);await fs.writeFile(workspace,own);
    const raw=readWorkspaceRagConfiguration({global,workspace});
    assert.deepEqual(raw.embedding,{model:'global-model',apiKey:'fixture-secret',baseUrl:'http://127.0.0.1:1234/v1'});
    assert.equal(raw.openCode.autoIndex.enabled,false);assert.equal(raw.description.enabled,false);
    assert.equal(await fs.readFile(global,'utf8'),base);assert.equal(await fs.readFile(workspace,'utf8'),own);
}));
