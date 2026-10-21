import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { RagDb, type IUpsertRow } from '../src/rag/rag-db';
import { indexSnapshotHash, rowFingerprint } from '../../shared/rag-index-contract.cjs';
vi.mock('../../shared/capacity.cjs', () => ({ reserveCapacity: async () => () => {} }));
const connection = process.env.RAG_CONTRACT_TEST_PG_URL;
const project = 'prj-semantic', generation = 'initial-' + createHash('md5').update(project).digest('hex');
const profile = { provider: 'openai', model: 'neurocenter/model-embed/sha256/' + 'a'.repeat(64), dimension: 3 };
const row = (id: string, embedding: number[]): IUpsertRow => ({ id, filePath: `src/${id}.ts`, content: '界'.repeat(2000), description: 'Заголовок',
    startLine: 1, endLine: 20, language: 'typescript', kind: 'code', role: null, quirkType: null, tags: null,
    contentHash: createHash('sha256').update('界'.repeat(2000)).digest('hex'), embedding });
const rows = [row('nearest', [1, 0, 0]), row('related', [0.8, 0.6, 0]), row('orthogonal', [0, 1, 0]), row('opposite', [-1, 0, 0])];
const snapshot = indexSnapshotHash(profile, Object.fromEntries(rows.map(value => [value.id, rowFingerprint(value)])));
const input = () => ({ projectId: project, generation, revision: 2, dataRevision: 3, profile, snapshot, embedding: [1, 0, 0] });
describe.skipIf(!connection)('Project semantic search with actual pgvector', () => {
    let admin: Client, db: RagDb; let created = false;
    const name = 'nc_rag_search_' + randomUUID().replaceAll('-', '');
    beforeAll(async () => {
        const url = new URL(connection!);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432' || url.pathname !== '/postgres') throw new Error('Use an isolated explicit non-5432 local PostgreSQL admin URL.');
        admin = new Client({ connectionString: url.toString() }); await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`); created = true;
        url.pathname = '/' + name; db = new RagDb({ url: url.toString() }); await db.setup();
        await db.applyDelta(project, generation, rows, [], { indexProfile: profile, snapshot: { hash: snapshot, rowCount: rows.length, complete: false } });
        await db.applyDelta(project, generation, [], [], { indexProfile: profile, snapshot: { hash: snapshot, rowCount: rows.length, complete: true } });
        const other = 'prj-other', otherGeneration = 'initial-' + createHash('md5').update(other).digest('hex'), otherRows = [row('secret-other-project', [1, 0, 0])];
        const hash = indexSnapshotHash(profile, Object.fromEntries(otherRows.map(value => [value.id, rowFingerprint(value)])));
        await db.applyDelta(other, otherGeneration, otherRows, [], { indexProfile: profile, snapshot: { hash, rowCount: 1, complete: false } });
        await db.applyDelta(other, otherGeneration, [], [], { indexProfile: profile, snapshot: { hash, rowCount: 1, complete: true } });
    });
    afterAll(async () => { await db?.close(); try { if (created) await admin.query(`DROP DATABASE "${name}"`); } finally { await admin?.end(); } });
    it('Ranks by cosine, excludes unrelated/opposite vectors and foreign projects', async () => {
        const result = await db.search(input()); expect(result.sources.map(source => source.id)).toEqual(['nearest', 'related']);
        expect(result.sources[0].score).toBeCloseTo(1); expect(result.sources[1].score).toBeCloseTo(0.8);
        expect(result.sources[0]).toMatchObject({ path: 'src/nearest.ts', title: 'Заголовок', startLine: 1, endLine: 20 });
        expect(Buffer.byteLength(result.sources[0].excerpt)).toBeLessThanOrEqual(3072);
    });
    it('Does not accept another generation, profile or changed snapshot', async () => {
        for (const patch of [{ generation: randomUUID() }, { snapshot: 'c'.repeat(64) }, { profile: { ...profile, dimension: 5 } }, { profile: { ...profile, model: 'foreign' } }]) {
            await expect(db.search({ ...input(), ...patch })).rejects.toMatchObject({ status: 409 });
        }
    });
    it('An empty sealed generation returns a genuine empty result', async () => {
        const key = 'prj-empty', gen = 'initial-' + createHash('md5').update(key).digest('hex'), hash = indexSnapshotHash(profile, {});
        await db.applyDelta(key, gen, [], [], { indexProfile: profile, snapshot: { hash, rowCount: 0, complete: true } });
        expect(await db.search({ ...input(), projectId: key, generation: gen, snapshot: hash })).toMatchObject({ sources: [] });
    });
    it('Unsealed partial sync blocks search and never supplies a partial baseline', async () => {
        await db.applyDelta(project, generation, [row('unfinished', [1, 0, 0])], [], { indexProfile: profile, snapshot: { hash: snapshot, rowCount: 5, complete: false } });
        await expect(db.search(input())).rejects.toMatchObject({ status: 409 });
    });
});
