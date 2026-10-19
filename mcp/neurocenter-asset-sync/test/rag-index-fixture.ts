import fs from 'node:fs/promises';
import path from 'node:path';
import { contentHash } from '../src/lib/lancedb.js';
import { rowFingerprint, indexSnapshotHash, embeddingSignature } from '../src/features/rag-index/contract.js';
export const profile = { provider: 'ollama', model: 'fixture-model', dimension: 3 };
export const row = (id: string) => ({ id, content: id, description: null, filePath: 'README.md', startLine: null, endLine: null,
    language: null, kind: '', role: null, quirkType: null, tags: null, embedding: [0.1, 0.2, 0.3] });
export async function readyIndex(root: string, store = path.join(root, '.opencode/rag_db')) {
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(root, 'opencode-rag.json'), JSON.stringify({ embedding: { ...profile, vectorDimension: 3 } }));
    await fs.writeFile(path.join(store, 'manifest.json'), JSON.stringify({ schemaVersion: 3, files: {}, lastIndexedAt: 10 }));
    await fs.writeFile(path.join(store, 'watcher-status.json'), JSON.stringify({ running: false, lastSuccessAt: 10, lastRunAt: 9, lastPassProblems: 0 }));
    await fs.writeFile(path.join(store, 'neurocenter-index-profile.json'), JSON.stringify({ schemaVersion: 1, state: 'ready', profile, indexedAt: 10,
        embeddingSignature: embeddingSignature(profile, 'http://127.0.0.1:11434/api') }));
}
export function metadata(rows: unknown[], complete = true) {
    const fingerprints = Object.fromEntries(rows.map((value: any) => [value.id, rowFingerprint(value)]));
    return { projectKey: 'test-project', fingerprintVersion: 1, indexProfile: profile, rowCount: rows.length, incompleteRows: 0,
        indexState: complete ? 'ready' : 'syncing', complete, snapshotHash: complete ? indexSnapshotHash(profile, fingerprints) : null,
        fingerprints, ids: Object.fromEntries(rows.map((value: any) => [value.id, contentHash(value.content)])) };
}
