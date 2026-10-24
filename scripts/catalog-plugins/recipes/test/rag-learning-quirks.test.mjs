import test from 'node:test';
import assert from 'node:assert/strict';
import {RAG_LEARNING_QUIRKS,RAG_REVISION} from '../opencode-rag.mjs';
import {RAG_PLUGIN_REVISION} from '../opencode-rag-plugin.mjs';
import {supportsLearningQuirks,QUIRKS_SOURCE_SHA256} from '../../../../services/shared/project-learning-quirks.cjs';

test('prepared RAG revisions explicitly declare the reviewed raw JSONL source schema',()=>{
    assert.deepEqual(RAG_LEARNING_QUIRKS,{schemaVersion:1,format:'opencode-rag-quirks-jsonl',sourceSha256:QUIRKS_SOURCE_SHA256});
    assert.equal(RAG_REVISION,'2.4.4-mcp.pack.13');assert.equal(RAG_PLUGIN_REVISION,'2.4.4-plugin.pack.13');
    for(const kind of ['mcp','plugin'])assert.equal(supportsLearningQuirks({schemaVersion:5,plugin:{kind},config:{extra:{learningQuirks:RAG_LEARNING_QUIRKS}}}),true);
});
