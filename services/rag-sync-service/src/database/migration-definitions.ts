import {createHash} from 'node:crypto';
import {RAG_GENERATION_SCHEMA} from '../rag/rag-generation-schema';
import {RAG_QUOTA_MIGRATION,RAG_QUOTA_SCHEMA} from '../rag/quota/rag-quota-schema';
import {DATABASE_LIFECYCLE_SCHEMA,PROJECT_IDENTITY_SCHEMA} from './migration-sql';
import type {SchemaObjects} from './schema-inspection';

export interface RagMigration {version:string;name:string;scope:'data'|'base'|'project';sql:string;objects:SchemaObjects;schemaSha256:string;lockTables?:readonly string[];}
export const sqlChecksum=(sql:string):string=>createHash('sha256').update(sql).digest('hex');

/** Structural digests come from these frozen SQL statements on PostgreSQL 16; physical column order is deliberately irrelevant. */
export const GENERATION_MIGRATION:RagMigration={version:'project-generations-1',name:'project-generations',scope:'data',sql:RAG_GENERATION_SCHEMA,
    objects:{tables:['rag_chunks','rag_index_state','rag_generations','rag_write_receipts'],indexes:['rag_chunks_generation_idx','rag_chunks_hash_idx'],
        functions:['neurocenter_rag_vector_dimension'],triggers:['rag_vector_dimension']},
    schemaSha256:'a5a340232a164d5bed5f5da816510e958797fe4d192e589e83b9f416e5d94797'};
export const LIFECYCLE_MIGRATION:RagMigration={version:'database-lifecycle-1',name:'database-lifecycle',scope:'base',sql:DATABASE_LIFECYCLE_SCHEMA,
    objects:{tables:['neurocenter_project_databases','neurocenter_database_purge_receipts']},schemaSha256:'c143148c4c6b0d83f810845db4cb0227bffa5ee06820b9d5c6e58a40d309537c'};
export const IDENTITY_MIGRATION:RagMigration={version:'project-identity-1',name:'project-identity',scope:'project',sql:PROJECT_IDENTITY_SCHEMA,
    objects:{tables:['neurocenter_database_identity']},schemaSha256:'b1744d2c2f30dab3cf2435ee74da5815e9cbed6a5f07f3799c00511ab920eaa3'};
export const RAG_MIGRATIONS=[GENERATION_MIGRATION,LIFECYCLE_MIGRATION,IDENTITY_MIGRATION] as const;
export const QUOTA_MIGRATION:RagMigration={version:RAG_QUOTA_MIGRATION,name:'rag-storage-budget',scope:'data',sql:RAG_QUOTA_SCHEMA,
    lockTables:['rag_chunks'],
    objects:{tables:['rag_storage_settings','rag_storage_budget','rag_quota_events'],
        functions:['neurocenter_rag_row_bytes','neurocenter_rag_write_lock','neurocenter_ensure_rag_budget','neurocenter_rag_budget_before',
            'neurocenter_rag_budget_after','neurocenter_rag_budget_truncate','neurocenter_check_rag_budget','neurocenter_audit_rag_budget'],
        triggers:['rag_budget_write_lock','rag_chunks_write_lock','rag_chunks_budget_before','rag_chunks_budget_after','rag_chunks_budget_truncate','rag_storage_quota_limit','rag_budget_audit']},
    schemaSha256:'fc3548440241b589f2c9679340417dd2d63ece96c3e86c86ccfaab30145a2d86'};

/** The quota migration retains its original SQL, checksum and separate historical ledger. */
export function ragMigrationManifest(){return [...RAG_MIGRATIONS,QUOTA_MIGRATION].map(({scope,version,name,sql})=>({scope,version,name,checksum:sqlChecksum(sql)}));}
