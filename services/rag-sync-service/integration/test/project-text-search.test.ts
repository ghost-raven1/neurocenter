import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectSchema } from '../../src/database/schema-inspection';
import { textSearchFixture } from './project-text-search.fixture';
import { textHash } from '../../src/project-text/text-values';
import { TEXT_KNOWLEDGE_LIMITS, textUploadCanonical } from '../../../shared/project-text-knowledge.cjs';
import { checkRagMigrations, migrateRag } from '../../src/database/migrations';
import {
    PROJECT_TEXT_MIGRATION,
    PROJECT_TEXT_LIMITS_MIGRATION,
    PROJECT_TEXT_SEARCH_MIGRATION,
    sqlChecksum,
    type IRagMigration,
} from '../../src/database/migration-definitions';
vi.mock('../../../shared/capacity.cjs', () => ({ reserveCapacity: async () => () => {} }));
vi.mock('../../src/rag/rag-features', () => ({ requireRagFeatures: async () => {} }));
vi.mock('../../src/project-text/text-authorization', () => ({ authorizeTextUpload: async () => {} }));
vi.mock('../../src/project-text/text-policy', () => ({
    readTextAdmission: async () => ({ revision: 0, limits: TEXT_KNOWLEDGE_LIMITS }),
}));
const connection = process.env.RAG_TEXT_TEST_PG_URL;
const fixtures: Awaited<ReturnType<typeof textSearchFixture>>[] = [];
const actor = { email: 'owner@test', activeRole: 'developer' };
const migrations = [PROJECT_TEXT_MIGRATION, PROJECT_TEXT_LIMITS_MIGRATION, PROJECT_TEXT_SEARCH_MIGRATION];
async function fixture() {
    const f = await textSearchFixture(connection!);
    fixtures.push(f);
    return f;
}
afterEach(async () => {
    for (const f of fixtures.splice(0)) await f.dispose();
});
async function put(f: Awaited<ReturnType<typeof fixture>>) {
    const input = {
        requestKey: randomUUID(),
        expectedRevision: 0,
        documents: [{ path: 'docs/ЁЖ.md', content: 'Квантовый кот\nЁЖ и ёлка\nexport function cancelJob() {}\n' }],
    };
    return f.text.upload(f.project, input, textHash(textUploadCanonical(input)), actor);
}
async function preserved(f: Awaited<ReturnType<typeof fixture>>) {
    const result: Record<string, unknown> = {};
    for (const table of ['project_text_documents', 'project_text_state', 'project_text_receipts', 'rag_storage_budget'])
        result[table] = (
            await f.pool.query(`SELECT to_jsonb(t)-'search_vector' AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)
        ).rows;
    return result;
}
async function verifyDigest(f: Awaited<ReturnType<typeof fixture>>, migration: IRagMigration) {
    const actual = sqlChecksum(JSON.stringify(await inspectSchema(f.pool, migration.objects)));
    expect(actual).toBe(migration.schemaSha256);
    console.info(JSON.stringify({ migration: migration.version, expected: migration.schemaSha256, actual }));
}
/** Reconstruct the frozen old schema only inside this disposable database. */
async function legacy(f: Awaited<ReturnType<typeof fixture>>) {
    await f.pool.query(`DROP INDEX project_text_search_idx;
        ALTER TABLE project_text_documents DROP COLUMN search_vector;
        ALTER TABLE project_text_documents ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,path||E'\\n'||content)) STORED;
        CREATE INDEX project_text_search_idx ON project_text_documents USING gin(search_vector);
        DROP FUNCTION neurocenter_text_search_fold(text);
        DELETE FROM neurocenter_rag_schema_versions WHERE version='project-text-search-1';`);
}

describe.skipIf(!connection)('Text search on owned C-locale PostgreSQL', () => {
    it('finds Russian mixed case, Ё and code while preserving literal citations', async () => {
        const f = await fixture();
        await put(f);
        for (const query of ['квантовый кот', 'КВАНТОВЫЙ КОТ', 'ёж', 'ЁЛКА', 'canceljob', 'CANCELJOB']) {
            const found = await f.text.search(f.project, { query });
            expect(found.sources).toHaveLength(1);
            expect(found.sources[0].path).toBe('docs/ЁЖ.md');
        }
        expect((await f.text.search(f.project, { query: 'квантовый' })).sources[0].excerpt).toContain('Квантовый кот');
        expect((await f.text.search('prj-other', { query: 'кот' })).sources).toEqual([]);
    });
    it('upgrades persisted vectors through both successors without changing content, receipt or quota', async () => {
        const f = await fixture();
        await legacy(f);
        await put(f);
        const before = await preserved(f);
        await f.pool.query(`ALTER TABLE project_text_documents DROP CONSTRAINT project_text_documents_path_check;
            ALTER TABLE project_text_documents ADD CONSTRAINT project_text_documents_path_check CHECK(octet_length(path) BETWEEN 1 AND 512);
            DELETE FROM neurocenter_rag_schema_versions WHERE version='project-text-limits-1';`);
        await verifyDigest(f, PROJECT_TEXT_MIGRATION);
        await migrateRag(f.pool, [PROJECT_TEXT_MIGRATION, PROJECT_TEXT_LIMITS_MIGRATION]);
        await verifyDigest(f, PROJECT_TEXT_LIMITS_MIGRATION);
        await checkRagMigrations(f.pool, [PROJECT_TEXT_MIGRATION, PROJECT_TEXT_LIMITS_MIGRATION]);
        await migrateRag(f.pool, migrations);
        await migrateRag(f.pool, migrations);
        expect((await checkRagMigrations(f.pool, migrations)).pending).toEqual([]);
        await verifyDigest(f, PROJECT_TEXT_SEARCH_MIGRATION);
        expect(await preserved(f)).toEqual(before);
        expect((await f.text.search(f.project, { query: 'КВАНТОВЫЙ ёж' })).sources).toHaveLength(1);
    });
    it('rolls back a failed successor including rebuilt vectors and retains the old verified schema', async () => {
        const f = await fixture();
        await legacy(f);
        await put(f);
        const before = await preserved(f);
        await expect(
            migrateRag(f.pool, [
                { ...PROJECT_TEXT_SEARCH_MIGRATION, sql: PROJECT_TEXT_SEARCH_MIGRATION.sql + 'SELECT 1/0;' },
            ]),
        ).rejects.toThrow();
        expect(await preserved(f)).toEqual(before);
        const checked = await checkRagMigrations(f.pool, migrations);
        expect(checked.pending).toEqual([PROJECT_TEXT_SEARCH_MIGRATION.version]);
        expect(
            (await f.pool.query("SELECT to_regprocedure('neurocenter_text_search_fold(text)') AS fn")).rows[0].fn,
        ).toBeNull();
        await migrateRag(f.pool, migrations);
        expect((await f.text.search(f.project, { query: 'ёж' })).sources).toHaveLength(1);
    });
});
